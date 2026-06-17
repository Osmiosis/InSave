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
}

interface Env {
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/sync") {
      return handleSync(request, env);
    }
    return new Response("Not found", { status: 404 });
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
  const stmt = env.DB.prepare(
    `INSERT INTO pending_capture
       (id, canonical_url, raw_payload, captured_at, source, status, parse_ok,
        saved_at, title, thumbnail, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );

  for (const r of records) {
    try {
      await stmt
        .bind(
          r.id, r.canonical_url, r.raw_payload, r.captured_at, r.source, r.status,
          r.parse_ok ? 1 : 0,
          r.saved_at ?? null, r.title ?? null, r.thumbnail ?? null, r.description ?? null,
        )
        .run();
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
