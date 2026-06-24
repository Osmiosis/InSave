import { runCron } from "./cron";
import { makeD1ReminderRepo } from "./d1-reminder-repo";

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
}

interface Env {
  DB: D1Database;
}

// Upsert: insert new captures, and on an id conflict (a re-synced state transition)
// update only the mutable columns. Identity columns (canonical_url, raw_payload,
// captured_at, source, parse_ok) are write-once and never touched here.
export const UPSERT_SQL = `INSERT INTO pending_capture
   (id, canonical_url, raw_payload, captured_at, source, status, parse_ok,
    saved_at, title, thumbnail, description, topic_tags, importance, tagged_at, author, media_type,
    user_id)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(id) DO UPDATE SET
   status = excluded.status,
   saved_at = excluded.saved_at,
   description = excluded.description,
   topic_tags = excluded.topic_tags,
   importance = excluded.importance,
   tagged_at = excluded.tagged_at,
   author = excluded.author,
   media_type = excluded.media_type,
   user_id = excluded.user_id`;

export function toBind(r: WireRecord): unknown[] {
  return [
    r.id, r.canonical_url, r.raw_payload, r.captured_at, r.source, r.status,
    r.parse_ok ? 1 : 0,
    r.saved_at ?? null, r.title ?? null, r.thumbnail ?? null, r.description ?? null,
    r.topic_tags ? JSON.stringify(r.topic_tags) : null,
    r.importance ?? null, r.tagged_at ?? null, r.author ?? null, r.media_type ?? null,
    r.user_id ?? null,
  ];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/sync") {
      return handleSync(request, env);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const repo = makeD1ReminderRepo(env.DB);
    // 04a: delivery is stubbed — log the digest that WOULD be pushed. PRD 04b swaps in Web Push.
    await runCron(repo, Date.now(), async (userId, due) => {
      console.log(`[cron] digest for ${userId}: ${due.map((d) => d.id).join(", ")}`);
    });
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
