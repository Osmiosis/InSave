import { createAuth } from "./auth";
import { resolveOwner, type SessionInfo } from "./owner";
import { planPendingMerge, buildPendingStatements, buildCollectionMerge, type MergeRow } from "./merge";
import { UPSERT_SQL, COLLECTIONS_UPSERT_SQL } from "./sql";
import { runCron } from "./cron";
import { makeD1ReminderRepo } from "./d1-reminder-repo";
import { makeNotify } from "./notify";
import { makeWebPushSender } from "./web-push-sender";
import type { PushSubscriptionRecord } from "./push-sender";
import { applyAction, type ReminderAction } from "../src/reminder/action";

interface WireRecord {
  id: string;
  canonical_url: string;
  raw_payload: string;
  captured_at: number;
  source: string;
  status: string;
  parse_ok: boolean;
  saved_at?: number;
  title?: string;
  thumbnail?: string;
  description?: string;
  topic_tags?: string[];
  importance?: string;
  tagged_at?: number;
  author?: string;
  media_type?: string;
  user_id?: string;
  collection_id?: string;
  deadline_at?: number;
}

interface Env {
  DB: D1Database;
  VAPID_SUBJECT: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  AUTH_BASE_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

// Reads the current Better Auth session from request headers. Injectable into
// handlers so the trust rule can be tested without a live auth backend.
type GetSession = (headers: Headers) => Promise<SessionInfo | null>;
const sessionReader = (env: Env): GetSession => (headers) =>
  createAuth(env).api.getSession({ headers });

export function parseSubscribe(body: unknown, now: number): PushSubscriptionRecord | null {
  const b = body as { user_id?: unknown; subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } } | null;
  const user_id = b?.user_id;
  const endpoint = b?.subscription?.endpoint;
  const p256dh = b?.subscription?.keys?.p256dh;
  const auth = b?.subscription?.keys?.auth;
  if (typeof user_id !== "string" || typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") {
    return null;
  }
  return { endpoint, user_id, p256dh, auth, created_at: now };
}

export function parseAction(
  body: unknown,
): { user_id: string; ids: string[]; action: ReminderAction } | null {
  const b = body as { user_id?: unknown; ids?: unknown; action?: unknown } | null;
  const user_id = b?.user_id;
  const ids = b?.ids;
  const action = b?.action;
  if (typeof user_id !== "string" || user_id.length === 0) return null;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === "string")) return null;
  if (action !== "done" && action !== "snooze" && action !== "open") return null;
  return { user_id, ids: ids as string[], action };
}

export function parsePull(userId: string | null): string | null {
  return typeof userId === "string" && userId.length > 0 ? userId : null;
}

// Upsert: insert new captures, and on an id conflict (a re-synced state transition)
// update only the mutable columns. Identity columns (canonical_url, raw_payload,
// captured_at, source, parse_ok) are write-once and never touched here.
export function toBind(r: WireRecord): unknown[] {
  return [
    r.id, r.canonical_url, r.raw_payload, r.captured_at, r.source, r.status,
    r.parse_ok ? 1 : 0,
    r.saved_at ?? null, r.title ?? null, r.thumbnail ?? null, r.description ?? null,
    r.topic_tags ? JSON.stringify(r.topic_tags) : null,
    r.importance ?? null, r.tagged_at ?? null, r.author ?? null, r.media_type ?? null,
    r.user_id ?? null,
    r.collection_id ?? null,
    r.deadline_at ?? null,
  ];
}

interface CollectionWire {
  id: string; user_id: string; name: string; created_at: number; is_default: boolean;
}

export function parseCollections(body: unknown): CollectionWire[] | null {
  if (!Array.isArray(body)) return null;
  const out: CollectionWire[] = [];
  for (const r of body as Record<string, unknown>[]) {
    if (
      typeof r?.id !== "string" || typeof r?.user_id !== "string" ||
      typeof r?.name !== "string" || typeof r?.created_at !== "number" ||
      typeof r?.is_default !== "boolean"
    ) return null;
    out.push({ id: r.id, user_id: r.user_id, name: r.name, created_at: r.created_at, is_default: r.is_default });
  }
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Better Auth owns everything under /api/auth/* (sign-in, callbacks, session).
    if (url.pathname.startsWith("/api/auth/")) {
      return createAuth(env).handler(request);
    }
    if (request.method === "POST" && url.pathname === "/api/sync") {
      return handleSync(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/subscribe") {
      return handleSubscribe(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/pull") {
      return handlePull(request, url, env);
    }
    if (request.method === "POST" && url.pathname === "/api/action") {
      return handleAction(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/merge") {
      return handleMerge(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/collections") {
      return handleCollections(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/collections") {
      return handleCollectionsPull(request, url, env);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const repo = makeD1ReminderRepo(env.DB);
    const sender = makeWebPushSender({
      subject: env.VAPID_SUBJECT,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    });
    await runCron(repo, Date.now(), makeNotify(repo, sender));
  },
};

export async function handleSync(
  request: Request,
  env: Env,
  getSession: GetSession = sessionReader(env),
): Promise<Response> {
  let records: WireRecord[];
  try {
    records = (await request.json()) as WireRecord[];
    if (!Array.isArray(records)) throw new Error("expected array");
  } catch {
    return new Response(JSON.stringify({ error: "bad payload" }), { status: 400 });
  }

  // Trust rule: when signed in, every record is owned by the account, ignoring
  // any client-supplied user_id. Anonymous records keep their own user_id.
  const { ownerId, authed } = await resolveOwner(getSession, request.headers, null);
  if (authed && ownerId) {
    for (const r of records) r.user_id = ownerId;
  }

  const accepted: string[] = [];
  const stmt = env.DB.prepare(UPSERT_SQL);

  for (const r of records) {
    try {
      await stmt.bind(...toBind(r)).run();
      accepted.push(r.id);
    } catch {
      // The insert threw (e.g. canonical_url already present under a different id).
      // Accept ONLY if the record is genuinely stored, so a real/transient failure
      // stays unaccepted and the client retries it instead of losing it.
      const existing = await env.DB.prepare(
        `SELECT 1 FROM pending_capture
         WHERE id = ? OR (canonical_url <> '' AND canonical_url = ? AND user_id = ?) LIMIT 1`,
      )
        .bind(r.id, r.canonical_url, r.user_id ?? null)
        .first();
      if (existing) accepted.push(r.id);
    }
  }

  return new Response(JSON.stringify({ accepted }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function handleCollections(
  request: Request,
  env: Env,
  getSession: GetSession = sessionReader(env),
): Promise<Response> {
  let rows: CollectionWire[] | null;
  try {
    rows = parseCollections(await request.json());
  } catch {
    rows = null;
  }
  if (!rows) return new Response(JSON.stringify({ error: "bad payload" }), { status: 400 });

  // Trust rule: signed-in collections are owned by the account.
  const { ownerId, authed } = await resolveOwner(getSession, request.headers, null);
  if (authed && ownerId) {
    for (const r of rows) r.user_id = ownerId;
  }

  const accepted: string[] = [];
  const stmt = env.DB.prepare(COLLECTIONS_UPSERT_SQL);
  for (const r of rows) {
    try {
      await stmt.bind(r.id, r.user_id, r.name, r.created_at, r.is_default ? 1 : 0).run();
      accepted.push(r.id);
    } catch {
      const existing = await env.DB.prepare(`SELECT 1 FROM collections WHERE id = ? LIMIT 1`).bind(r.id).first();
      if (existing) accepted.push(r.id);
    }
  }
  return new Response(JSON.stringify({ accepted }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

async function handleCollectionsPull(
  request: Request,
  url: URL,
  env: Env,
  getSession: GetSession = sessionReader(env),
): Promise<Response> {
  const claimed = parsePull(url.searchParams.get("user_id"));
  const { ownerId } = await resolveOwner(getSession, request.headers, claimed);
  if (!ownerId) return new Response(JSON.stringify({ error: "bad payload" }), { status: 400 });
  const { results } = await env.DB
    .prepare(`SELECT id, user_id, name, created_at, is_default FROM collections WHERE user_id = ?`)
    .bind(ownerId)
    .all<Record<string, unknown>>();
  const collections = (results ?? []).map((r) => ({
    id: String(r.id), user_id: String(r.user_id), name: String(r.name),
    created_at: Number(r.created_at), is_default: Number(r.is_default) === 1,
  }));
  return new Response(JSON.stringify({ collections }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

async function handleSubscribe(
  request: Request,
  env: Env,
  getSession: GetSession = sessionReader(env),
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad payload" }), { status: 400 });
  }
  const record = parseSubscribe(body, Date.now());
  if (!record) {
    return new Response(JSON.stringify({ error: "bad payload" }), { status: 400 });
  }
  // Trust rule: a signed-in device's subscription is owned by the account so
  // reminders target the right identity.
  const { ownerId, authed } = await resolveOwner(getSession, request.headers, record.user_id);
  if (authed && ownerId) record.user_id = ownerId;
  await makeD1ReminderRepo(env.DB).putSubscription(record);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export async function handlePull(
  request: Request,
  url: URL,
  env: Env,
  getSession: GetSession = sessionReader(env),
): Promise<Response> {
  const claimed = parsePull(url.searchParams.get("user_id"));
  const { ownerId } = await resolveOwner(getSession, request.headers, claimed);
  if (!ownerId) {
    return new Response(JSON.stringify({ error: "bad payload" }), { status: 400 });
  }
  const items = await makeD1ReminderRepo(env.DB).listByUser(ownerId);
  return new Response(JSON.stringify({ items }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function handleAction(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad payload" }), { status: 400 });
  }
  const parsed = parseAction(body);
  if (!parsed) {
    return new Response(JSON.stringify({ error: "bad payload" }), { status: 400 });
  }
  const repo = makeD1ReminderRepo(env.DB);
  const now = Date.now();
  for (const id of parsed.ids) {
    const item = await repo.getById(id);
    if (!item) continue; // unknown id — skip (idempotent)
    await repo.writeReminderState(id, applyAction(item, parsed.action, now));
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const MERGE_COLS =
  "id, canonical_url, status, saved_at, description, topic_tags, importance, tagged_at, author, media_type, collection_id, deadline_at";

// Absorb an anonymous device's data into the signed-in account (PRD 08 §7).
// Re-points pending_capture/collections/subscriptions and coalesces reels that
// collide on canonical_url; the account's server-owned reminder state is
// untouched. Runs in one atomic D1 batch; idempotent and non-destructive.
export async function executeMerge(
  db: D1Database,
  accountId: string,
  anonId: string,
): Promise<number> {
  const anonRows =
    (await db.prepare(`SELECT ${MERGE_COLS} FROM pending_capture WHERE user_id = ?`).bind(anonId).all<MergeRow>()).results ?? [];
  const acctRows =
    (await db.prepare(`SELECT ${MERGE_COLS} FROM pending_capture WHERE user_id = ? AND canonical_url <> ''`).bind(accountId).all<MergeRow>()).results ?? [];

  const byUrl = new Map<string, MergeRow>();
  for (const r of acctRows) byUrl.set(r.canonical_url, r);

  const ops = planPendingMerge(anonRows, byUrl);

  // Default-collection collapse: keep a single "Saved" default. reelRemap must
  // precede the reel re-point (it matches on the still-anonymous user_id).
  const accountDefault = await db.prepare(`SELECT id FROM collections WHERE user_id = ? AND is_default = 1 LIMIT 1`).bind(accountId).first<{ id: string }>();
  const anonDefault = await db.prepare(`SELECT id FROM collections WHERE user_id = ? AND is_default = 1 LIMIT 1`).bind(anonId).first<{ id: string }>();
  const coll = buildCollectionMerge(accountId, anonId, accountDefault?.id ?? null, anonDefault?.id ?? null);

  const stmts = [
    ...coll.reelRemap,
    ...buildPendingStatements(ops, accountId, anonId),
    ...coll.collectionOps,
  ];

  // Push subscriptions follow their owner (§7.6); endpoint is a unique PK so a
  // plain re-point cannot collide.
  stmts.push({ sql: `UPDATE push_subscriptions SET user_id = ? WHERE user_id = ?`, params: [accountId, anonId] });

  // Settings: the account's own row is authoritative; adopt the anon row only
  // when the account has none (user_settings PK is user_id).
  const hasAccountSettings = await db.prepare(`SELECT 1 FROM user_settings WHERE user_id = ? LIMIT 1`).bind(accountId).first();
  stmts.push(
    hasAccountSettings
      ? { sql: `DELETE FROM user_settings WHERE user_id = ?`, params: [anonId] }
      : { sql: `UPDATE user_settings SET user_id = ? WHERE user_id = ?`, params: [accountId, anonId] },
  );

  await db.batch(stmts.map((s) => db.prepare(s.sql).bind(...s.params)));
  return ops.length;
}

export async function handleMerge(
  request: Request,
  env: Env,
  getSession: GetSession = sessionReader(env),
): Promise<Response> {
  const { ownerId, authed } = await resolveOwner(getSession, request.headers, null);
  if (!authed || !ownerId) {
    return new Response(JSON.stringify({ error: "auth required" }), { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad payload" }), { status: 400 });
  }
  const anonId = (body as { anon_id?: unknown })?.anon_id;
  // Nothing to absorb: no anon id, or it already is the account (e.g. re-run).
  if (typeof anonId !== "string" || !anonId || anonId === ownerId) {
    return new Response(JSON.stringify({ ok: true, merged: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  const merged = await executeMerge(env.DB, ownerId, anonId);
  return new Response(JSON.stringify({ ok: true, merged }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
