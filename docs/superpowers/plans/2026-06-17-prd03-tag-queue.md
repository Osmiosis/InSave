# PRD 03 — Tag Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Tag Queue: a page that lists `pending` captured/promoted reels and lets the user assign a reusable topic tag + optional one-time importance, turning them into `tagged` tracked items that sync to D1.

**Architecture:** Extends the existing local-first model — new store transitions on the shared `pending_capture` record (IndexedDB), the same idempotent `drainSync` push, and a Worker upsert widened from `DO NOTHING` to `DO UPDATE` so state transitions reach D1. A new `tag.html` + `src/tag-view.ts` page renders the queue; the chip set is *derived* from distinct tags on the user's tagged items (no second sync path).

**Tech Stack:** Vite + TypeScript (no framework), `idb` (IndexedDB v3), Cloudflare Worker + D1, vitest + fake-indexeddb.

## Global Constraints

- No new runtime dependencies. (`idb`, `fflate` only; everything else dev.)
- All IndexedDB access goes through `openInsaveDB()` in `src/db.ts` (single schema owner).
- Every mutating store method sets `synced = false`; the caller fires `drainSync` fire-and-forget after.
- Immutable identity columns are never updated by sync: `id`, `canonical_url`, `raw_payload`, `captured_at`, `source`, `parse_ok`.
- Injectable clock: store methods take `now: () => number = () => Date.now()` so tests are deterministic. No `Math.random`/`Date.now` literals in test assertions.
- Tests live in `tests/`, mirroring `src/` paths. Run with `npx vitest run`. Type-check + build with `npm run build` (`tsc && vite build`).
- DOM-glue entry modules (`*-view.ts`) get no unit test (they touch `document` at module load; vitest env is node) — verified by `tsc` + `vite build` + a `docs/manual-verification.md` checklist entry, consistent with `triage-view.ts`.

---

### Task 1: Data model — widen types + DB v3 `by_status` index

**Files:**
- Modify: `src/types.ts` (lines 8, 10-24)
- Modify: `src/db.ts:8-20`
- Test: `tests/db.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `CaptureStatus = "pending" | "tagged" | "dismissed"`; `PendingCapture` gains `topic_tags?: string[]`, `importance?: "normal" | "matters"`, `tagged_at?: number`, `author?: string`, `media_type?: "reel" | "post"`. `openInsaveDB()` (v3) exposes a `by_status` index on `pending_capture`.

- [ ] **Step 1: Widen the status type and add fields in `src/types.ts`**

Replace line 8:

```ts
export type CaptureStatus = "pending" | "tagged" | "dismissed";
```

Replace the `PendingCapture` interface (lines 10-24) with:

```ts
export interface PendingCapture {
  id: string;            // client-generated UUID
  canonical_url: string; // dedupe key ("" when parse_ok is false and no URL recovered)
  raw_payload: string;   // JSON.stringify of the original SharePayload
  captured_at: number;   // epoch ms
  source: CaptureSource;
  status: CaptureStatus;
  parse_ok: boolean;
  synced: boolean;       // local-only flag, not sent to backend as a column
  // Import metadata / enrichment seam (undefined for share-captures).
  saved_at?: number;
  title?: string;
  thumbnail?: string;
  description?: string;
  // Tag Queue (PRD 03). Undefined until the item is tagged.
  topic_tags?: string[];
  importance?: "normal" | "matters";
  tagged_at?: number;    // epoch ms, set on transition to "tagged"
  // Carried from backlog import at promote time; null for share-captures.
  author?: string;
  media_type?: "reel" | "post";
}
```

- [ ] **Step 2: Bump IndexedDB to v3 with a `by_status` index in `src/db.ts`**

Replace the `openInsaveDB` function body (lines 7-24) with:

```ts
// Single owner of the IndexedDB schema. v2 adds imported_item; v3 adds a
// by_status index on pending_capture for the Tag Queue.
export async function openInsaveDB(): Promise<IDBPDatabase> {
  const db = await openDB(DB_NAME, 3, {
    upgrade(database, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        const os = database.createObjectStore(PENDING_STORE, { keyPath: "id" });
        os.createIndex("by_canonical_url", "canonical_url", { unique: false });
      }
      if (oldVersion < 2) {
        const os = database.createObjectStore(IMPORTED_STORE, { keyPath: "id" });
        os.createIndex("by_canonical_url", "canonical_url", { unique: false });
      }
      if (oldVersion < 3) {
        // Existing pending records already carry status="pending"; only the index is new.
        tx.objectStore(PENDING_STORE).createIndex("by_status", "status", { unique: false });
      }
    },
  });
  // Auto-close when another context requests a version change (e.g. deleteDatabase in tests).
  db.addEventListener("versionchange", () => db.close());
  return db;
}
```

- [ ] **Step 3: Write the failing db test**

Create `tests/db.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { indexedDB } from "fake-indexeddb";
import { openInsaveDB, PENDING_STORE } from "../src/db";

describe("db schema", () => {
  beforeEach(async () => {
    await new Promise<void>((res) => {
      const del = indexedDB.deleteDatabase("insave");
      del.onsuccess = () => res();
      del.onerror = () => res();
    });
  });

  it("opens at version 3 with a by_status index on pending_capture", async () => {
    const db = await openInsaveDB();
    expect(db.version).toBe(3);
    const tx = db.transaction(PENDING_STORE, "readonly");
    expect([...tx.store.indexNames]).toContain("by_status");
    expect([...tx.store.indexNames]).toContain("by_canonical_url");
  });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS (1 test). If it fails to find `by_status`, the v3 upgrade in Step 2 is wrong.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (Type changes have no runtime test; `tsc` is the gate.)

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/db.ts tests/db.test.ts
git commit -m "feat: widen CaptureStatus + add tag fields, DB v3 by_status index (PRD 03)"
```

---

### Task 2: pending-store transitions + derived tag set

**Files:**
- Modify: `src/pending-store.ts` (whole file)
- Modify: `tests/sync.test.ts:13-22` (fake must satisfy widened interface)
- Modify: `tests/import/promote.test.ts:20-23` (fake must satisfy widened interface)
- Test: `tests/pending-store.test.ts` (add cases)

**Interfaces:**
- Consumes: `PendingCapture`, `CaptureStatus` (Task 1); `openInsaveDB`, `PENDING_STORE`, `by_status` index (Task 1).
- Produces: `createPendingStore(now?: () => number)`; `PendingStore` gains
  `listByStatus(status: CaptureStatus): Promise<PendingCapture[]>` (newest-first by `captured_at`),
  `tag(id: string, opts: { topic_tags: string[]; importance?: "normal" | "matters" }): Promise<void>`,
  `dismiss(id: string): Promise<void>`, `restore(id: string): Promise<void>`,
  `listDistinctTags(): Promise<string[]>` (deduped union across `tagged` items, alphabetical).

- [ ] **Step 1: Write the failing store tests**

Append these cases inside the `describe("pending-store", ...)` block in `tests/pending-store.test.ts` (before its closing `});`):

```ts
  it("lists by status, newest first", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a", captured_at: 100 }));
    await store.put(rec({ id: "b", canonical_url: "u-b", captured_at: 300 }));
    await store.put(rec({ id: "c", canonical_url: "u-c", captured_at: 200, status: "tagged", topic_tags: ["x"] }));
    const pending = await store.listByStatus("pending");
    expect(pending.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("tags an item: sets status, tagged_at, tags, importance, unsynced", async () => {
    const store = await createPendingStore(() => 7777);
    await store.put(rec({ id: "a", canonical_url: "u-a", synced: true }));
    await store.tag("a", { topic_tags: ["claude tricks"], importance: "matters" });
    const [r] = await store.listByStatus("tagged");
    expect(r.id).toBe("a");
    expect(r.status).toBe("tagged");
    expect(r.tagged_at).toBe(7777);
    expect(r.topic_tags).toEqual(["claude tricks"]);
    expect(r.importance).toBe("matters");
    expect(r.synced).toBe(false);
  });

  it("tag defaults importance to normal", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a" }));
    await store.tag("a", { topic_tags: ["gym"] });
    const [r] = await store.listByStatus("tagged");
    expect(r.importance).toBe("normal");
  });

  it("tag is idempotent on the same id (no duplicate rows)", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a" }));
    await store.tag("a", { topic_tags: ["gym"] });
    await store.tag("a", { topic_tags: ["gym"] });
    expect(await store.listByStatus("tagged")).toHaveLength(1);
  });

  it("dismiss and restore flip status and mark unsynced", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a", synced: true }));
    await store.dismiss("a");
    expect((await store.listByStatus("dismissed")).map((r) => r.id)).toEqual(["a"]);
    await store.restore("a");
    expect((await store.listByStatus("pending")).map((r) => r.id)).toEqual(["a"]);
    expect((await store.getByCanonicalUrl("u-a"))?.synced).toBe(false);
  });

  it("listDistinctTags unions tags across tagged items, excluding dismissed", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a" }));
    await store.put(rec({ id: "b", canonical_url: "u-b" }));
    await store.put(rec({ id: "c", canonical_url: "u-c" }));
    await store.tag("a", { topic_tags: ["gym"] });
    await store.tag("b", { topic_tags: ["gym", "skincare"] });
    await store.tag("c", { topic_tags: ["robotics"] });
    await store.dismiss("c"); // dismissed item's tags drop out of the chip set
    expect(await store.listDistinctTags()).toEqual(["gym", "skincare"]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/pending-store.test.ts`
Expected: FAIL — `store.listByStatus`/`tag`/`dismiss`/`restore`/`listDistinctTags` are not functions.

- [ ] **Step 3: Implement the store changes in `src/pending-store.ts`**

Replace the whole file with:

```ts
import { openInsaveDB, PENDING_STORE } from "./db";
import type { CaptureStatus, PendingCapture } from "./types";

export interface PendingStore {
  put(record: PendingCapture): Promise<void>;
  getByCanonicalUrl(canonicalUrl: string): Promise<PendingCapture | undefined>;
  listUnsynced(): Promise<PendingCapture[]>;
  markSynced(ids: string[]): Promise<void>;
  listByStatus(status: CaptureStatus): Promise<PendingCapture[]>;
  tag(id: string, opts: { topic_tags: string[]; importance?: "normal" | "matters" }): Promise<void>;
  dismiss(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  listDistinctTags(): Promise<string[]>;
}

export async function createPendingStore(
  now: () => number = () => Date.now(),
): Promise<PendingStore> {
  const db = await openInsaveDB();

  async function patch(id: string, fields: Partial<PendingCapture>): Promise<void> {
    const tx = db.transaction(PENDING_STORE, "readwrite");
    const r = (await tx.store.get(id)) as PendingCapture | undefined;
    if (r) await tx.store.put({ ...r, ...fields, synced: false });
    await tx.done;
  }

  return {
    async put(record) {
      await db.put(PENDING_STORE, record);
    },
    async getByCanonicalUrl(canonicalUrl) {
      if (!canonicalUrl) return undefined;
      return db.getFromIndex(PENDING_STORE, "by_canonical_url", canonicalUrl);
    },
    async listUnsynced() {
      const all = (await db.getAll(PENDING_STORE)) as PendingCapture[];
      return all.filter((r) => !r.synced);
    },
    async markSynced(ids) {
      const tx = db.transaction(PENDING_STORE, "readwrite");
      for (const id of ids) {
        const r = (await tx.store.get(id)) as PendingCapture | undefined;
        if (r) await tx.store.put({ ...r, synced: true });
      }
      await tx.done;
    },
    async listByStatus(status) {
      const all = (await db.getAllFromIndex(
        PENDING_STORE,
        "by_status",
        status,
      )) as PendingCapture[];
      return all.sort((a, b) => b.captured_at - a.captured_at);
    },
    async tag(id, opts) {
      await patch(id, {
        status: "tagged",
        topic_tags: opts.topic_tags,
        importance: opts.importance ?? "normal",
        tagged_at: now(),
      });
    },
    async dismiss(id) {
      await patch(id, { status: "dismissed" });
    },
    async restore(id) {
      await patch(id, { status: "pending" });
    },
    async listDistinctTags() {
      const tagged = (await db.getAllFromIndex(
        PENDING_STORE,
        "by_status",
        "tagged",
      )) as PendingCapture[];
      const set = new Set<string>();
      for (const r of tagged) for (const t of r.topic_tags ?? []) set.add(t);
      return [...set].sort();
    },
  };
}
```

- [ ] **Step 4: Update the test fakes that implement `PendingStore`**

In `tests/sync.test.ts`, replace `storeWith` (lines 13-22) with:

```ts
function storeWith(unsynced: PendingCapture[]): PendingStore & { marked: string[] } {
  const marked: string[] = [];
  return {
    marked,
    async put() {},
    async getByCanonicalUrl() { return undefined; },
    async listUnsynced() { return unsynced; },
    async markSynced(ids) { marked.push(...ids); },
    async listByStatus() { return []; },
    async tag() {},
    async dismiss() {},
    async restore() {},
    async listDistinctTags() { return []; },
  };
}
```

In `tests/import/promote.test.ts`, replace the `pendingStore` object literal (line 22) with:

```ts
      pendingStore: { put, getByCanonicalUrl: async () => undefined, listUnsynced: async () => [], markSynced: async () => {}, listByStatus: async () => [], tag: async () => {}, dismiss: async () => {}, restore: async () => {}, listDistinctTags: async () => [] },
```

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all pass (the 6 new pending-store cases + previously green files). Then `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add src/pending-store.ts tests/pending-store.test.ts tests/sync.test.ts tests/import/promote.test.ts
git commit -m "feat: tag/dismiss/restore/listByStatus/listDistinctTags on pending-store (PRD 03)"
```

---

### Task 3: Worker upsert `DO UPDATE` + D1 schema columns

**Files:**
- Modify: `worker/index.ts` (whole file)
- Modify: `schema.sql:1-13`
- Test: `tests/worker-sync.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime (the wire is structural).
- Produces: exported `UPSERT_SQL` (string) and `toBind(r: WireRecord): unknown[]` from `worker/index.ts`. `WireRecord` widened with `topic_tags?`, `importance?`, `tagged_at?`, `author?`, `media_type?`.

- [ ] **Step 1: Write the failing worker test**

Create `tests/worker-sync.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { UPSERT_SQL, toBind } from "../worker/index";

function wire(over: Record<string, unknown> = {}) {
  return {
    id: "id-1",
    canonical_url: "https://www.instagram.com/reel/A",
    raw_payload: "{}",
    captured_at: 1000,
    source: "import",
    status: "tagged",
    parse_ok: true,
    ...over,
  } as never;
}

describe("worker sync upsert", () => {
  it("serializes topic_tags to a JSON string", () => {
    expect(toBind(wire({ topic_tags: ["gym", "claude tricks"] }))[11]).toBe('["gym","claude tricks"]');
  });

  it("binds null for absent optional columns", () => {
    const b = toBind(wire());
    expect(b[11]).toBeNull(); // topic_tags
    expect(b[12]).toBeNull(); // importance
    expect(b[13]).toBeNull(); // tagged_at
    expect(b[14]).toBeNull(); // author
    expect(b[15]).toBeNull(); // media_type
  });

  it("maps parse_ok boolean to 1/0", () => {
    expect(toBind(wire({ parse_ok: true }))[6]).toBe(1);
    expect(toBind(wire({ parse_ok: false }))[6]).toBe(0);
  });

  it("upserts mutable columns on id conflict but never identity columns", () => {
    expect(UPSERT_SQL).toContain("ON CONFLICT(id) DO UPDATE SET");
    for (const col of ["status", "topic_tags", "importance", "tagged_at", "author", "media_type", "description", "saved_at"]) {
      expect(UPSERT_SQL).toContain(`${col} = excluded.${col}`);
    }
    // identity columns are not in the DO UPDATE clause
    const updateClause = UPSERT_SQL.slice(UPSERT_SQL.indexOf("DO UPDATE SET"));
    for (const col of ["canonical_url", "raw_payload", "captured_at", "source", "parse_ok"]) {
      expect(updateClause).not.toContain(`${col} = excluded.${col}`);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/worker-sync.test.ts`
Expected: FAIL — `UPSERT_SQL`/`toBind` are not exported.

- [ ] **Step 3: Rewrite `worker/index.ts`**

Replace the whole file with:

```ts
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
}

interface Env {
  DB: D1Database;
}

// Upsert: insert new captures, and on an id conflict (a re-synced state transition)
// update only the mutable columns. Identity columns (canonical_url, raw_payload,
// captured_at, source, parse_ok) are write-once and never touched here.
export const UPSERT_SQL = `INSERT INTO pending_capture
   (id, canonical_url, raw_payload, captured_at, source, status, parse_ok,
    saved_at, title, thumbnail, description, topic_tags, importance, tagged_at, author, media_type)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(id) DO UPDATE SET
   status = excluded.status,
   saved_at = excluded.saved_at,
   description = excluded.description,
   topic_tags = excluded.topic_tags,
   importance = excluded.importance,
   tagged_at = excluded.tagged_at,
   author = excluded.author,
   media_type = excluded.media_type`;

export function toBind(r: WireRecord): unknown[] {
  return [
    r.id, r.canonical_url, r.raw_payload, r.captured_at, r.source, r.status,
    r.parse_ok ? 1 : 0,
    r.saved_at ?? null, r.title ?? null, r.thumbnail ?? null, r.description ?? null,
    r.topic_tags ? JSON.stringify(r.topic_tags) : null,
    r.importance ?? null, r.tagged_at ?? null, r.author ?? null, r.media_type ?? null,
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
```

- [ ] **Step 4: Add the new columns to `schema.sql`**

Replace the `CREATE TABLE` block (lines 1-13) with:

```sql
CREATE TABLE IF NOT EXISTS pending_capture (
  id            TEXT PRIMARY KEY,
  canonical_url TEXT,
  raw_payload   TEXT NOT NULL,
  captured_at   INTEGER NOT NULL,
  source        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  parse_ok      INTEGER NOT NULL DEFAULT 1,
  saved_at      INTEGER,
  title         TEXT,
  thumbnail     TEXT,
  description   TEXT,
  topic_tags    TEXT,
  importance    TEXT,
  tagged_at     INTEGER,
  author        TEXT,
  media_type    TEXT
);
```

(Leave the `idx_canonical_url` unique index below it unchanged.)

- [ ] **Step 5: Run the worker test + full suite + type-check**

Run: `npx vitest run` then `npx tsc --noEmit`
Expected: all pass; no type errors.

- [ ] **Step 6: Commit**

```bash
git add worker/index.ts schema.sql tests/worker-sync.test.ts
git commit -m "feat: Worker DO UPDATE upsert + D1 tag columns (PRD 03)"
```

---

### Task 4: promote carries `author` + `media_type` to the tracked set

**Files:**
- Modify: `src/import/promote.ts:19-31`
- Test: `tests/import/promote.test.ts` (extend the first case)

**Interfaces:**
- Consumes: `PendingCapture.author`/`media_type` (Task 1); `ImportedItem.author`/`media_type` (existing).
- Produces: a promoted `pending_capture` now carrying `author` and `media_type` from the imported item (the PRD 02b deferral lands here).

- [ ] **Step 1: Extend the failing promote test**

In `tests/import/promote.test.ts`, add these two assertions to the end of the first test (`"flips state, writes a source=import pending record, enriches, and drains"`), just before its closing `});` (after the `captured_at` assertion):

```ts
    expect(rec.author).toBe("a");
    expect(rec.media_type).toBe("reel");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/import/promote.test.ts`
Expected: FAIL — `rec.author`/`rec.media_type` are `undefined`.

- [ ] **Step 3: Carry the fields in `src/import/promote.ts`**

Replace the `record` object (lines 19-31) with:

```ts
  const record: PendingCapture = {
    id: deps.uuid(),
    canonical_url: item.canonical_url,
    raw_payload: item.raw_payload,
    captured_at: item.imported_at,
    source: "import",
    status: "pending",
    parse_ok: item.parse_ok,
    synced: false,
    saved_at: item.saved_at,
    author: item.author,
    media_type: item.media_type,
    ...(enrichment ?? {}),
    ...(item.caption ? { description: item.caption } : {}),
  };
```

- [ ] **Step 4: Run the promote test + full suite**

Run: `npx vitest run tests/import/promote.test.ts` then `npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/import/promote.ts tests/import/promote.test.ts
git commit -m "feat: carry author + media_type onto promoted pending_capture (PRD 03)"
```

---

### Task 5: Tag Queue page (`tag.html` + `src/tag-view.ts`) + wiring

**Files:**
- Create: `tag.html`
- Create: `src/tag-view.ts`
- Modify: `vite.config.ts:7-13` (add input entry)
- Modify: `src/sw.ts:9` (add `/tag.html` to `SHELL`)
- Modify: `index.html:21` (add queue link)
- Modify: `docs/manual-verification.md` (append PRD 03 checklist)

**Interfaces:**
- Consumes: `createPendingStore` + `listByStatus`/`tag`/`dismiss`/`restore`/`listDistinctTags` (Task 2); `drainSync` (existing); `PendingCapture` (Task 1).
- Produces: a user-facing page; no module exports consumed by other tasks. (DOM glue — no unit test; gated by `tsc` + `vite build` + manual checklist.)

- [ ] **Step 1: Create `tag.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#111111" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <title>InSave — Tag your queue</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #111; color: #eee; }
      header { padding: 20px; }
      h1 { font-size: 1.3rem; margin: 0 0 8px; }
      p { color: #aaa; margin: 4px 0; line-height: 1.5; }
      .empty { padding: 40px 20px; text-align: center; color: #888; display: none; }
      .empty.show { display: block; }
      .card { border-top: 1px solid #222; padding: 14px 20px; }
      .card .meta { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
      .card .author { font-weight: 600; }
      .badge { font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
               background: #2a2a2a; border: 1px solid #3a3a3a; border-radius: 4px; padding: 1px 6px; color: #bbb; }
      .card a.link { color: #8ab4ff; text-decoration: none; word-break: break-all; }
      .card .caption { color: #ccc; margin: 6px 0; }
      .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
      .chip { background: #1e2a3a; color: #cfe0ff; border: 1px solid #2c3e57; border-radius: 14px; padding: 4px 12px; font-size: 14px; }
      .chip.example { background: #1a1a1a; color: #666; border-color: #2a2a2a; }
      .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 6px; }
      .controls input { background: #1a1a1a; color: #eee; border: 1px solid #3a3a3a; border-radius: 6px; padding: 6px 10px; font-size: 14px; }
      button { background: #2a2a2a; color: #eee; border: 1px solid #3a3a3a; border-radius: 6px; padding: 6px 12px; font-size: 14px; }
      button.matters { background: #3a2f1a; border-color: #5a4a22; color: #ffd98a; }
      .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
               background: #222; border: 1px solid #3a3a3a; border-radius: 8px; padding: 10px 16px;
               display: none; align-items: center; gap: 12px; }
      .toast.show { display: flex; }
    </style>
  </head>
  <body>
    <header>
      <h1>Tag your queue</h1>
      <p>Give each saved reel a topic and, if it really matters, one tap to flag it.
         Tap a chip or type a new tag — that's it.</p>
      <p><a href="/" style="color:#8ab4ff">← Back</a></p>
    </header>
    <div id="empty" class="empty">Nothing to tag. Capture or import some reels first.</div>
    <div id="list"></div>
    <div id="toast" class="toast" role="status"></div>
    <script type="module" src="/src/tag-view.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `src/tag-view.ts`**

```ts
import { createPendingStore } from "./pending-store";
import { drainSync } from "./sync";
import type { PendingCapture } from "./types";

const listEl = document.getElementById("list")!;
const emptyEl = document.getElementById("empty")!;
const toastEl = document.getElementById("toast")!;

// Non-binding first-run examples: shown only when the user has no tags yet.
const EXAMPLE_TAGS = ["skincare", "robotics", "claude tricks"];

let toastTimer: ReturnType<typeof setTimeout> | undefined;

function showUndoToast(message: string, onUndo: () => void): void {
  toastEl.textContent = message + " ";
  const btn = document.createElement("button");
  btn.textContent = "Undo";
  btn.addEventListener("click", () => {
    onUndo();
    hideToast();
  });
  toastEl.appendChild(btn);
  toastEl.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}

function hideToast(): void {
  toastEl.classList.remove("show");
  toastEl.textContent = "";
}

function authorLabel(item: PendingCapture): string {
  if (item.author) return "@" + item.author;
  try {
    return new URL(item.canonical_url).host;
  } catch {
    return "saved reel";
  }
}

async function main(): Promise<void> {
  const store = await createPendingStore();
  const drain = () => { drainSync(store).catch(() => {}); };

  const items = await store.listByStatus("pending");
  const chips = await store.listDistinctTags();

  if (items.length === 0) {
    emptyEl.classList.add("show");
    return;
  }

  for (const item of items) {
    listEl.appendChild(renderCard(item, chips, store, drain));
  }
}

function renderCard(
  item: PendingCapture,
  chips: string[],
  store: Awaited<ReturnType<typeof createPendingStore>>,
  drain: () => void,
): HTMLElement {
  const card = document.createElement("section");
  card.className = "card";

  const meta = document.createElement("div");
  meta.className = "meta";
  const author = document.createElement("span");
  author.className = "author";
  author.textContent = authorLabel(item);
  meta.appendChild(author);
  if (item.media_type) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = item.media_type;
    meta.appendChild(badge);
  }
  card.appendChild(meta);

  if (item.description) {
    const cap = document.createElement("p");
    cap.className = "caption";
    cap.textContent = item.description;
    card.appendChild(cap);
  }

  const link = document.createElement("a");
  link.className = "link";
  link.href = item.canonical_url || "#";
  link.textContent = item.parse_ok ? "Open in Instagram ↗" : "(unreadable link — needs review)";
  link.target = "_blank";
  link.rel = "noopener";
  card.appendChild(link);

  // Importance toggle (default normal; one tap to elevate).
  let importance: "normal" | "matters" = "normal";
  const importanceBtn = document.createElement("button");
  importanceBtn.textContent = "☆ Matters";
  importanceBtn.addEventListener("click", () => {
    importance = importance === "normal" ? "matters" : "normal";
    importanceBtn.classList.toggle("matters", importance === "matters");
    importanceBtn.textContent = importance === "matters" ? "★ Matters" : "☆ Matters";
  });

  async function applyTag(topic: string): Promise<void> {
    await store.tag(item.id, { topic_tags: [topic], importance });
    drain();
    card.remove();
    if (listEl.children.length === 0) emptyEl.classList.add("show");
  }

  // Reusable chips (or non-binding examples on first run).
  const chipsRow = document.createElement("div");
  chipsRow.className = "chips";
  if (chips.length > 0) {
    for (const tag of chips) {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.textContent = tag;
      chip.addEventListener("click", () => { void applyTag(tag); });
      chipsRow.appendChild(chip);
    }
  } else {
    for (const tag of EXAMPLE_TAGS) {
      const chip = document.createElement("button");
      chip.className = "chip example";
      chip.textContent = tag;
      chip.disabled = true; // examples demonstrate the gesture; they are not real tags
      chipsRow.appendChild(chip);
    }
  }
  card.appendChild(chipsRow);

  // New-tag input + dismiss.
  const controls = document.createElement("div");
  controls.className = "controls";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "New tag…";
  const addBtn = document.createElement("button");
  addBtn.textContent = "Tag";
  const commit = () => {
    const v = input.value.trim();
    if (v) void applyTag(v);
  };
  addBtn.addEventListener("click", commit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); });

  const dismissBtn = document.createElement("button");
  dismissBtn.textContent = "Dismiss";
  dismissBtn.addEventListener("click", async () => {
    await store.dismiss(item.id);
    drain();
    card.remove();
    if (listEl.children.length === 0) emptyEl.classList.add("show");
    showUndoToast("Dismissed.", () => {
      void store.restore(item.id).then(() => {
        drain();
        emptyEl.classList.remove("show");
        listEl.appendChild(renderCard(item, chips, store, drain));
      });
    });
  });

  controls.appendChild(importanceBtn);
  controls.appendChild(input);
  controls.appendChild(addBtn);
  controls.appendChild(dismissBtn);
  card.appendChild(controls);

  return card;
}

void main();
```

- [ ] **Step 3: Register the page in `vite.config.ts`**

In the `input` object (lines 7-13), add a `tag` entry after `importPage`:

```ts
        importPage: resolve(__dirname, "import.html"),
        tag: resolve(__dirname, "tag.html"),
```

- [ ] **Step 4: Add `/tag.html` to the SW shell in `src/sw.ts`**

Replace line 9:

```ts
const SHELL = ["/", "/index.html", "/captured.html", "/tag.html", "/manifest.webmanifest"];
```

- [ ] **Step 5: Link the queue from `index.html`**

After line 21 (the import link `<p>`), add:

```html
      <p><a href="/tag.html" style="color:#8ab4ff">Tag your queue →</a></p>
```

- [ ] **Step 6: Append the PRD 03 manual-verification checklist**

Add to the end of `docs/manual-verification.md`:

```markdown

## PRD 03 — Tag Queue

### Setup
- Apply the new D1 columns. Fresh local DB: `wrangler d1 execute insave --local --file=schema.sql`.
  Existing remote DB (add by ALTER, since `CREATE TABLE IF NOT EXISTS` won't modify an existing table):
  `wrangler d1 execute insave --command "ALTER TABLE pending_capture ADD COLUMN topic_tags TEXT; ALTER TABLE pending_capture ADD COLUMN importance TEXT; ALTER TABLE pending_capture ADD COLUMN tagged_at INTEGER; ALTER TABLE pending_capture ADD COLUMN author TEXT; ALTER TABLE pending_capture ADD COLUMN media_type TEXT;"`

### Checklist (PRD §10)
- [ ] `/tag.html` lists only `pending` items (captured + promoted) together, newest first.
- [ ] First run (no tags yet) shows greyed-out non-binding example chips; they do not apply.
- [ ] Typing a new tag + Tag processes the item; that tag appears as a real one-tap chip next session.
- [ ] Tapping an existing chip processes a typical item in a single tap.
- [ ] "Matters" elevates importance in one optional tap; default is normal; never re-prompted.
- [ ] Dismiss removes the item and offers Undo; Undo restores it to the queue.
- [ ] Tagged/dismissed items leave the queue; in D1 their `status`, `topic_tags` (JSON), `importance`, `tagged_at` are set (tagged) — check `SELECT status, topic_tags, importance FROM pending_capture`.
- [ ] Promoted import items show `@author`, caption, and a reel/post badge on the card; share-captures fall back to the URL host.
- [ ] Each card opens the original reel in Instagram (link-out); unparsed items show "needs review" instead.
- [ ] Tag offline → transition drains to D1 on reconnect (status updates, no duplicate rows).
```

- [ ] **Step 7: Type-check + production build**

Run: `npm run build`
Expected: `tsc` clean; Vite emits `tag.html` + a `tag` bundle and `/sw.js` at the dist root. Confirm `dist/tag.html` exists.

- [ ] **Step 8: Commit**

```bash
git add tag.html src/tag-view.ts vite.config.ts src/sw.ts index.html docs/manual-verification.md
git commit -m "feat: Tag Queue page + wiring + manual checklist (PRD 03)"
```

---

### Task 6: Final verification + notes.md summary

**Files:**
- Modify: `notes.md` (append PRD 03 entry)
- Modify: `docs/superpowers/specs/2026-06-17-prd03-tag-queue-design.md:8` (flip Status to Locked)

**Interfaces:**
- Consumes: the completed implementation.
- Produces: the chronological PRD summary (per the user's standing `notes.md` convention) and a locked spec.

- [ ] **Step 1: Full verification gate**

Run: `npx vitest run` then `npm run build`
Expected: all tests green (record the count); `tsc` clean; build emits `dist/tag.html`. Do NOT write the summary until this passes — evidence before assertions.

- [ ] **Step 2: Append the PRD 03 summary to `notes.md`**

Append a new `## PRD 03 — Tag Queue — <date>` section in the same structure as the existing entries (What it is / Decisions made / How it works / Delivered (verified) / Still manual / open / Artifacts / Next PRDs). Fill "Delivered" with the actual final test count and files from Step 1. Reference the spec and this plan under Artifacts. List the remaining manual-verification items and the D1 `ALTER TABLE` under "Still manual / open". Set Next PRDs to "04 Reminder Engine".

- [ ] **Step 3: Lock the design spec**

In `docs/superpowers/specs/2026-06-17-prd03-tag-queue-design.md`, change line 8 `**Status:** Approved for planning` → `**Status:** Locked (implemented)`.

- [ ] **Step 4: Commit**

```bash
git add notes.md docs/superpowers/specs/2026-06-17-prd03-tag-queue-design.md
git commit -m "docs: PRD 03 notes summary + lock spec"
```

---

## Self-Review notes (verification against the spec)

- **Spec §5.1 type changes** → Task 1. **§5.2 v3 index** → Task 1. **§5.3 D1 columns** → Task 3 (schema.sql) + manual ALTER (Task 5 checklist).
- **§6 sync transition (`DO UPDATE`, immutable identity columns, canonical_url fallback preserved)** → Task 3.
- **§7 derived tag set + first-run examples** → `listDistinctTags` (Task 2) + example chips (Task 5).
- **§8 store API (`listByStatus`/`tag`/`dismiss`/`restore`/`listDistinctTags`, `synced=false`, injectable clock, idempotent tag)** → Task 2.
- **§9 UI (tag.html, chips, new-tag, importance toggle, dismiss+undo toast, author/host fallback, caption+badge, link-out, parse_ok review)** → Task 5.
- **§9 SW shell + vite input + index link** → Task 5.
- **§10 tests (pending-store, worker, db v3, promote carry)** → Tasks 2/3/1/4. `tag-view.ts` intentionally untested (DOM glue) → Global Constraints + Task 5.
- **PRD §10 acceptance criteria** → covered across Tasks 2/3/5 + manual checklist (Task 5).
- **Type consistency:** `tag(id, { topic_tags, importance })`, `listByStatus(status)`, `listDistinctTags()` signatures identical in interface (Task 2), store impl (Task 2), and call sites (Task 5). `toBind`/`UPSERT_SQL` names identical in worker (Task 3) and worker test (Task 3). `media_type`/`author` identical across types (Task 1), promote (Task 4), worker wire (Task 3).
