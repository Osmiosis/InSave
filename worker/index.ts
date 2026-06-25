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
}

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
export const UPSERT_SQL = `INSERT INTO pending_capture
   (id, canonical_url, raw_payload, captured_at, source, status, parse_ok,
    saved_at, title, thumbnail, description, topic_tags, importance, tagged_at, author, media_type,
    user_id, collection_id, deadline_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(id) DO UPDATE SET
   status = excluded.status,
   saved_at = excluded.saved_at,
   description = excluded.description,
   topic_tags = excluded.topic_tags,
   importance = excluded.importance,
   tagged_at = excluded.tagged_at,
   author = excluded.author,
   media_type = excluded.media_type,
   user_id = excluded.user_id,
   collection_id = excluded.collection_id,
   deadline_at = excluded.deadline_at`;

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

// Collections sync rail. Identity columns (id, user_id, created_at) are write-once;
// on an id conflict only the mutable columns (name, is_default) are updated.
export const COLLECTIONS_UPSERT_SQL = `INSERT INTO collections
   (id, user_id, name, created_at, is_default)
 VALUES (?, ?, ?, ?, ?)
 ON CONFLICT(id) DO UPDATE SET
   name = excluded.name,
   is_default = excluded.is_default`;

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
    if (request.method === "POST" && url.pathname === "/api/sync") {
      return handleSync(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/subscribe") {
      return handleSubscribe(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/pull") {
      return handlePull(url, env);
    }
    if (request.method === "POST" && url.pathname === "/api/action") {
      return handleAction(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/collections") {
      return handleCollections(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/collections") {
      return handleCollectionsPull(url, env);
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

async function handleSync(request: Request, env: Env): Promise<Response> {
  let records: WireRecord[];
  try {
    records = (await request.json()) as WireRecord[];
    if (!Array.isArray(records)) throw new Error("expected array");
  } catch {
    return new Response(JSON.stringify({ error: "bad payload" }), { status: 400 });
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
         WHERE id = ? OR (canonical_url <> '' AND canonical_url = ?) LIMIT 1`,
      )
        .bind(r.id, r.canonical_url)
        .first();
      if (existing) accepted.push(r.id);
    }
  }

  return new Response(JSON.stringify({ accepted }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function handleCollections(request: Request, env: Env): Promise<Response> {
  let rows: CollectionWire[] | null;
  try {
    rows = parseCollections(await request.json());
  } catch {
    rows = null;
  }
  if (!rows) return new Response(JSON.stringify({ error: "bad payload" }), { status: 400 });

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

async function handleCollectionsPull(url: URL, env: Env): Promise<Response> {
  const userId = parsePull(url.searchParams.get("user_id"));
  if (!userId) return new Response(JSON.stringify({ error: "bad payload" }), { status: 400 });
  const { results } = await env.DB
    .prepare(`SELECT id, user_id, name, created_at, is_default FROM collections WHERE user_id = ?`)
    .bind(userId)
    .all<Record<string, unknown>>();
  const collections = (results ?? []).map((r) => ({
    id: String(r.id), user_id: String(r.user_id), name: String(r.name),
    created_at: Number(r.created_at), is_default: Number(r.is_default) === 1,
  }));
  return new Response(JSON.stringify({ collections }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

async function handleSubscribe(request: Request, env: Env): Promise<Response> {
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
  await makeD1ReminderRepo(env.DB).putSubscription(record);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function handlePull(url: URL, env: Env): Promise<Response> {
  const userId = parsePull(url.searchParams.get("user_id"));
  if (!userId) {
    return new Response(JSON.stringify({ error: "bad payload" }), { status: 400 });
  }
  const items = await makeD1ReminderRepo(env.DB).listByUser(userId);
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
