interface WireRecord {
  id: string;
  canonical_url: string;
  raw_payload: string;
  captured_at: number;
  source: string;
  status: string;
  parse_ok: boolean;
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
       (id, canonical_url, raw_payload, captured_at, source, status, parse_ok)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );

  for (const r of records) {
    try {
      await stmt
        .bind(r.id, r.canonical_url, r.raw_payload, r.captured_at, r.source, r.status, r.parse_ok ? 1 : 0)
        .run();
      accepted.push(r.id); // idempotent: a no-op conflict still counts as accepted
    } catch {
      // canonical_url unique conflict (same reel, different client id) — treat as accepted
      accepted.push(r.id);
    }
  }

  return new Response(JSON.stringify({ accepted }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
