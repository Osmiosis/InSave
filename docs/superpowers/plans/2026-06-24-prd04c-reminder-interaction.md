# PRD 04c — Reminder Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the reminder loop — device pull/reconcile from D1 (restore + refresh), a review-view UI listing the active queue, and Done/Snooze/Open actions reaching the server from both the review view and the notification's own buttons.

**Architecture:** Pure units (`applyAction`, `mergePulled`, `rowToPending`, `assemblePayload`, parsers) carry the logic and are unit-tested; thin worker endpoints (`/api/pull`, `/api/action`) and client glue (`pullAndReconcile`, the review view, SW action routing) compose them. Reminder state stays cron-owned: actions write only server-owned columns; reconciliation keeps device-owned content local.

**Tech Stack:** TypeScript, Cloudflare Worker (`fetch` + `scheduled`) + D1, Web Push + service worker, `idb` (IndexedDB), vitest + fake-indexeddb.

## Global Constraints

- No new runtime dependencies, no new D1 tables or columns (04c only reads back + writes existing reminder columns).
- Actions write ONLY server-owned reminder columns (`reminder_status`, `next_due_at`, `cycle_count`, `ignored_count`, `last_surfaced_at`) — consistent with 04a ownership. Reconciliation keeps every device-owned field (`status`, `topic_tags`, `importance`, `description`, identity) local.
- `applyAction` reuses 04a `response.ts` (`markDone`/`snooze`/`markOpened`); no new transition logic.
- Pure modules and IDB-only glue are unit-tested (vitest / fake-indexeddb); the D1 adapter, worker endpoints, service-worker handlers, and the DOM review view are verified via `docs/manual-verification.md`.
- Tests live in `tests/`. Run `npx vitest run`; type-check + build `npm run build` (`tsc && vite build`).
- Reminder action set: `"done" | "snooze" | "open"`.

---

### Task 1: Extend `assemblePayload` with `user_id` + `ids`

**Files:**
- Modify: `src/reminder/payload.ts`
- Modify: `worker/notify.ts:9` (call passes `userId`)
- Test: `tests/reminder/payload.test.ts`

**Interfaces:**
- Consumes: `PendingCapture`.
- Produces: `assemblePayload(userId: string, due: PendingCapture[]): string` → JSON `{ title, body, count, user_id, ids }`.

- [ ] **Step 1: Update the failing test in `tests/reminder/payload.test.ts`**

Replace the two `it(...)` cases with:

```ts
  it("includes user_id, ids, and a singular body for one item", () => {
    const p = JSON.parse(assemblePayload("u1", [item("a")]));
    expect(p).toEqual({ title: "InSave", body: "1 reel worth revisiting", count: 1, user_id: "u1", ids: ["a"] });
  });

  it("includes all ids and a plural body for several items", () => {
    const p = JSON.parse(assemblePayload("u1", [item("a"), item("b"), item("c")]));
    expect(p.body).toBe("3 reels worth revisiting");
    expect(p.count).toBe(3);
    expect(p.ids).toEqual(["a", "b", "c"]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/reminder/payload.test.ts`
Expected: FAIL — `assemblePayload` takes one arg / output lacks `user_id`/`ids`.

- [ ] **Step 3: Update `src/reminder/payload.ts`**

```ts
import type { PendingCapture } from "../types";

// Shared notification payload (worker builds it; the service worker renders + acts on it).
export function assemblePayload(userId: string, due: PendingCapture[]): string {
  const count = due.length;
  const body = count === 1 ? "1 reel worth revisiting" : `${count} reels worth revisiting`;
  return JSON.stringify({ title: "InSave", body, count, user_id: userId, ids: due.map((d) => d.id) });
}
```

- [ ] **Step 4: Update the caller in `worker/notify.ts`**

Change the payload line to pass `userId`:

```ts
    const payload = assemblePayload(userId, due);
```

- [ ] **Step 5: Run tests + type-check**

Run: `npx vitest run` then `npx tsc --noEmit`
Expected: all pass (payload test + makeNotify test unaffected); no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/reminder/payload.ts worker/notify.ts tests/reminder/payload.test.ts
git commit -m "feat: carry user_id + ids in the push payload (PRD 04c)"
```

---

### Task 2: `applyAction` (pure)

**Files:**
- Create: `src/reminder/action.ts`
- Test: `tests/reminder/action.test.ts`

**Interfaces:**
- Consumes: `PendingCapture`; `markDone`/`snooze`/`markOpened` (04a `response.ts`); `presetFor` (04a `spacing.ts`).
- Produces: `ReminderAction = "done" | "snooze" | "open"`; `applyAction(item, action, now): Partial<PendingCapture>`.

- [ ] **Step 1: Write the failing test**

Create `tests/reminder/action.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyAction } from "../../src/reminder/action";
import { presetFor } from "../../src/reminder/spacing";
import type { PendingCapture } from "../../src/types";

function item(over: Partial<PendingCapture> = {}): PendingCapture {
  return {
    id: "i", canonical_url: "u", raw_payload: "{}", captured_at: 0,
    source: "import", status: "tagged", parse_ok: true, synced: true,
    importance: "matters", reminder_status: "active", cycle_count: 2, ignored_count: 3, ...over,
  };
}

describe("applyAction", () => {
  it("done retires the item", () => {
    expect(applyAction(item(), "done", 1000)).toEqual({ reminder_status: "done" });
  });

  it("snooze defers one base interval and stays active", () => {
    expect(applyAction(item(), "snooze", 1000)).toEqual({
      reminder_status: "active", next_due_at: 1000 + presetFor("matters").initialDelay,
    });
  });

  it("open resets ignored_count without retiring", () => {
    expect(applyAction(item(), "open", 1000)).toEqual({ ignored_count: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/reminder/action.test.ts`
Expected: FAIL — cannot find module `../../src/reminder/action`.

- [ ] **Step 3: Implement `src/reminder/action.ts`**

```ts
import type { PendingCapture } from "../types";
import { markDone, snooze, markOpened } from "./response";

export type ReminderAction = "done" | "snooze" | "open";

// Maps a user action to the server-owned reminder-state patch (reuses 04a response.ts).
export function applyAction(
  item: PendingCapture,
  action: ReminderAction,
  now: number,
): Partial<PendingCapture> {
  switch (action) {
    case "done":
      return markDone(item);
    case "snooze":
      return snooze(item, now);
    case "open":
      return markOpened(item);
  }
}
```

- [ ] **Step 4: Run the test + type-check**

Run: `npx vitest run tests/reminder/action.test.ts` then `npx tsc --noEmit`
Expected: PASS (3 tests); no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/reminder/action.ts tests/reminder/action.test.ts
git commit -m "feat: applyAction maps done/snooze/open to reminder-state patch (PRD 04c)"
```

---

### Task 3: `mergePulled` + `rowToPending` (pure)

**Files:**
- Create: `src/reminder/reconcile-pull.ts`
- Create: `src/reminder/row-to-pending.ts`
- Test: `tests/reminder/reconcile-pull.test.ts`
- Test: `tests/reminder/row-to-pending.test.ts`

**Interfaces:**
- Consumes: `PendingCapture`.
- Produces: `mergePulled(local: PendingCapture | undefined, remote: PendingCapture): PendingCapture`; `rowToPending(row: Record<string, unknown>): PendingCapture`.

- [ ] **Step 1: Write the failing `mergePulled` test**

Create `tests/reminder/reconcile-pull.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mergePulled } from "../../src/reminder/reconcile-pull";
import type { PendingCapture } from "../../src/types";

function rec(over: Partial<PendingCapture>): PendingCapture {
  return {
    id: "a", canonical_url: "u", raw_payload: "{}", captured_at: 0,
    source: "import", status: "tagged", parse_ok: true, synced: true, ...over,
  };
}

describe("mergePulled", () => {
  it("inserts a remote-only record whole (reinstall restore)", () => {
    const remote = rec({ reminder_status: "active", next_due_at: 5, topic_tags: ["gym"] });
    expect(mergePulled(undefined, remote)).toEqual({ ...remote, synced: true });
  });

  it("overlays only the server-owned fields, keeping local device content", () => {
    const local = rec({ topic_tags: ["gym"], importance: "matters", status: "tagged", reminder_status: "active", cycle_count: 1, synced: false });
    const remote = rec({ topic_tags: ["SERVER-WINS?"], importance: "normal", status: "dismissed", reminder_status: "expired", next_due_at: 99, cycle_count: 7, ignored_count: 2, last_surfaced_at: 50 });
    const merged = mergePulled(local, remote);
    // device-owned kept from local:
    expect(merged.topic_tags).toEqual(["gym"]);
    expect(merged.importance).toBe("matters");
    expect(merged.status).toBe("tagged");
    expect(merged.synced).toBe(false);
    // server-owned taken from remote:
    expect(merged.reminder_status).toBe("expired");
    expect(merged.next_due_at).toBe(99);
    expect(merged.cycle_count).toBe(7);
    expect(merged.ignored_count).toBe(2);
    expect(merged.last_surfaced_at).toBe(50);
  });
});
```

- [ ] **Step 2: Write the failing `rowToPending` test**

Create `tests/reminder/row-to-pending.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { rowToPending } from "../../src/reminder/row-to-pending";

describe("rowToPending", () => {
  it("rehydrates a D1 row into a PendingCapture", () => {
    const p = rowToPending({
      id: "a", canonical_url: "u", raw_payload: "{}", captured_at: 10,
      source: "import", status: "tagged", parse_ok: 1,
      topic_tags: '["gym","skincare"]', importance: "matters", tagged_at: 20,
      author: "creator", media_type: "reel", user_id: "u1",
      reminder_status: "active", next_due_at: 30, cycle_count: 2, ignored_count: 0, last_surfaced_at: 25,
    });
    expect(p.parse_ok).toBe(true);
    expect(p.topic_tags).toEqual(["gym", "skincare"]);
    expect(p.synced).toBe(true);
    expect(p.reminder_status).toBe("active");
    expect(p.next_due_at).toBe(30);
    expect(p.user_id).toBe("u1");
  });

  it("normalizes nulls and a parse_ok of 0", () => {
    const p = rowToPending({
      id: "b", canonical_url: "", raw_payload: "{}", captured_at: 0,
      source: "share_target", status: "pending", parse_ok: 0,
      topic_tags: null, importance: null, author: null, media_type: null,
      reminder_status: null, next_due_at: null,
    });
    expect(p.parse_ok).toBe(false);
    expect(p.topic_tags).toBeUndefined();
    expect(p.importance).toBeUndefined();
    expect(p.reminder_status).toBeUndefined();
    expect(p.next_due_at).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `npx vitest run tests/reminder/reconcile-pull.test.ts tests/reminder/row-to-pending.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `src/reminder/reconcile-pull.ts`**

```ts
import type { PendingCapture } from "../types";

// Reconciliation rule: remote is authoritative for the five server-owned reminder columns;
// local keeps all device-owned content. A record with no local copy is inserted whole.
export function mergePulled(local: PendingCapture | undefined, remote: PendingCapture): PendingCapture {
  if (!local) return { ...remote, synced: true };
  return {
    ...local,
    reminder_status: remote.reminder_status,
    next_due_at: remote.next_due_at,
    cycle_count: remote.cycle_count,
    ignored_count: remote.ignored_count,
    last_surfaced_at: remote.last_surfaced_at,
  };
}
```

- [ ] **Step 5: Implement `src/reminder/row-to-pending.ts`**

```ts
import type { CaptureSource, CaptureStatus, Importance, PendingCapture, ReminderStatus } from "../types";

// Rehydrates a raw D1 pending_capture row into a PendingCapture: topic_tags JSON->array,
// parse_ok int->bool, nullable columns -> undefined, synced (local-only) -> true.
export function rowToPending(row: Record<string, unknown>): PendingCapture {
  const num = (v: unknown): number | undefined => (v == null ? undefined : Number(v));
  const str = (v: unknown): string | undefined => (v == null ? undefined : String(v));

  let topic_tags: string[] | undefined;
  if (row.topic_tags != null) {
    try {
      topic_tags = JSON.parse(String(row.topic_tags)) as string[];
    } catch {
      topic_tags = undefined;
    }
  }

  return {
    id: String(row.id),
    canonical_url: String(row.canonical_url ?? ""),
    raw_payload: String(row.raw_payload ?? "{}"),
    captured_at: Number(row.captured_at ?? 0),
    source: String(row.source ?? "import") as CaptureSource,
    status: String(row.status ?? "pending") as CaptureStatus,
    parse_ok: Number(row.parse_ok ?? 0) === 1,
    synced: true,
    saved_at: num(row.saved_at),
    title: str(row.title),
    thumbnail: str(row.thumbnail),
    description: str(row.description),
    topic_tags,
    importance: str(row.importance) as Importance | undefined,
    tagged_at: num(row.tagged_at),
    author: str(row.author),
    media_type: str(row.media_type) as PendingCapture["media_type"],
    user_id: str(row.user_id),
    reminder_status: str(row.reminder_status) as ReminderStatus | undefined,
    next_due_at: num(row.next_due_at),
    cycle_count: num(row.cycle_count),
    ignored_count: num(row.ignored_count),
    last_surfaced_at: num(row.last_surfaced_at),
  };
}
```

- [ ] **Step 6: Run both tests + type-check**

Run: `npx vitest run tests/reminder/reconcile-pull.test.ts tests/reminder/row-to-pending.test.ts` then `npx tsc --noEmit`
Expected: PASS (2 + 2 tests); no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/reminder/reconcile-pull.ts src/reminder/row-to-pending.ts tests/reminder/reconcile-pull.test.ts tests/reminder/row-to-pending.test.ts
git commit -m "feat: mergePulled reconciliation + rowToPending deserialization (PRD 04c)"
```

---

### Task 4: Repo read methods + `/api/pull` + `/api/action`

**Files:**
- Modify: `worker/reminder-repo.ts`
- Modify: `worker/d1-reminder-repo.ts`
- Modify: `worker/index.ts`
- Modify: `tests/reminder/cron.test.ts` (fake repo gains the 2 read methods)
- Test: `tests/worker-action.test.ts`

**Interfaces:**
- Consumes: `applyAction`/`ReminderAction` (Task 2), `rowToPending` (Task 3), `makeD1ReminderRepo` (04a).
- Produces: `ReminderRepo` gains `listByUser`, `getById`; `parseAction(body)` + `parsePull(userId)` exported from `worker/index.ts`; `GET /api/pull` + `POST /api/action` routes.

- [ ] **Step 1: Extend the `ReminderRepo` interface in `worker/reminder-repo.ts`**

Add after `deleteSubscription`:

```ts
  listByUser(userId: string): Promise<PendingCapture[]>;
  getById(id: string): Promise<PendingCapture | undefined>;
```

- [ ] **Step 2: Implement them in `worker/d1-reminder-repo.ts`**

Add the import at the top:

```ts
import { rowToPending } from "../src/reminder/row-to-pending";
```

Add these methods inside the returned object (after `deleteSubscription`):

```ts
    async listByUser(userId) {
      const { results } = await db
        .prepare(`SELECT * FROM pending_capture WHERE user_id = ?`)
        .bind(userId)
        .all<Record<string, unknown>>();
      return (results ?? []).map(rowToPending);
    },

    async getById(id) {
      const row = await db
        .prepare(`SELECT * FROM pending_capture WHERE id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
      return row ? rowToPending(row) : undefined;
    },
```

- [ ] **Step 3: Update the cron-test fake repo in `tests/reminder/cron.test.ts`**

Add (after the `deleteSubscription` line in the `repo: ReminderRepo = { ... }` object):

```ts
    async listByUser() { return []; },
    async getById() { return undefined; },
```

- [ ] **Step 4: Write the failing parser tests**

Create `tests/worker-action.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseAction, parsePull } from "../worker/index";

describe("parseAction", () => {
  it("accepts a well-formed action body", () => {
    expect(parseAction({ user_id: "u1", ids: ["a", "b"], action: "snooze" })).toEqual({
      user_id: "u1", ids: ["a", "b"], action: "snooze",
    });
  });

  it("rejects malformed bodies", () => {
    expect(parseAction({ ids: ["a"], action: "done" })).toBeNull(); // no user_id
    expect(parseAction({ user_id: "u1", ids: [], action: "done" })).toBeNull(); // empty ids
    expect(parseAction({ user_id: "u1", ids: ["a"], action: "nope" })).toBeNull(); // bad action
    expect(parseAction({ user_id: "u1", ids: [1, 2], action: "done" })).toBeNull(); // non-string ids
    expect(parseAction(null)).toBeNull();
  });
});

describe("parsePull", () => {
  it("returns the user_id when present", () => {
    expect(parsePull("u1")).toBe("u1");
  });
  it("returns null for an empty/missing user_id", () => {
    expect(parsePull("")).toBeNull();
    expect(parsePull(null)).toBeNull();
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run tests/worker-action.test.ts`
Expected: FAIL — `parseAction`/`parsePull` not exported.

- [ ] **Step 6: Wire `worker/index.ts` — parsers, routes, handlers**

Add imports at the top (after the existing worker imports):

```ts
import { applyAction, type ReminderAction } from "../src/reminder/action";
```

Add the exported parsers (near `parseSubscribe`):

```ts
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
```

Add routes inside `fetch` (before the `return new Response("Not found"...)`):

```ts
    if (request.method === "GET" && url.pathname === "/api/pull") {
      return handlePull(url, env);
    }
    if (request.method === "POST" && url.pathname === "/api/action") {
      return handleAction(request, env);
    }
```

Add the handlers at the bottom of the file (after `handleSubscribe`):

```ts
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
```

- [ ] **Step 7: Run tests + type-check + build**

Run: `npx vitest run` then `npm run build`
Expected: all tests pass (parser cases + the cron tests still green with the extended fake); `tsc` clean; Vite build succeeds. (The `/api/pull`+`/api/action` D1 paths are exercised on-device; the parsers + `applyAction` are unit-tested.)

- [ ] **Step 8: Commit**

```bash
git add worker/reminder-repo.ts worker/d1-reminder-repo.ts worker/index.ts tests/reminder/cron.test.ts tests/worker-action.test.ts
git commit -m "feat: listByUser/getById repo + /api/pull + /api/action (PRD 04c)"
```

---

### Task 5: Client pull + review view + SW action routing

**Files:**
- Create: `src/reminder-pull.ts`
- Create: `review.html`
- Create: `src/review-view.ts`
- Modify: `vite.config.ts:11` (add `review` input)
- Modify: `src/sw.ts` (push actions + notificationclick routing)
- Modify: `index.html` (review link)
- Test: `tests/reminder-pull.test.ts`

**Interfaces:**
- Consumes: `mergePulled` (Task 3), `getUserId`/`openInsaveDB`/`PENDING_STORE` (04a/04b), `applyAction` semantics via `/api/action`.
- Produces: `pullAndReconcile(fetchFn?): Promise<void>`; the review page; SW Done/Snooze routing.

- [ ] **Step 1: Write the failing `pullAndReconcile` test**

Create `tests/reminder-pull.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { indexedDB } from "fake-indexeddb";
import { createPendingStore } from "../src/pending-store";
import { pullAndReconcile } from "../src/reminder-pull";
import { openInsaveDB, PENDING_STORE } from "../src/db";
import type { PendingCapture } from "../src/types";

function rec(over: Partial<PendingCapture>): PendingCapture {
  return {
    id: "a", canonical_url: "u", raw_payload: "{}", captured_at: 0,
    source: "import", status: "tagged", parse_ok: true, synced: true, ...over,
  };
}

describe("pullAndReconcile", () => {
  beforeEach(async () => {
    await new Promise<void>((res) => {
      const del = indexedDB.deleteDatabase("insave");
      del.onsuccess = () => res();
      del.onerror = () => res();
    });
  });

  it("overlays server reminder state but keeps local tags, and inserts new records", async () => {
    const store = await createPendingStore(() => 0, () => "u1");
    await store.put(rec({ id: "a", topic_tags: ["gym"], reminder_status: undefined }));

    const remote: PendingCapture[] = [
      rec({ id: "a", topic_tags: ["SERVER"], reminder_status: "active", next_due_at: 50 }),
      rec({ id: "b", topic_tags: ["new"], reminder_status: "active", next_due_at: 70 }),
    ];
    const fetchFn = (async () => new Response(JSON.stringify({ items: remote }), { status: 200 })) as unknown as typeof fetch;

    await pullAndReconcile(fetchFn);

    const db = await openInsaveDB();
    const a = (await db.get(PENDING_STORE, "a")) as PendingCapture;
    const b = (await db.get(PENDING_STORE, "b")) as PendingCapture;
    expect(a.topic_tags).toEqual(["gym"]); // local device content kept
    expect(a.reminder_status).toBe("active"); // server state overlaid
    expect(a.next_due_at).toBe(50);
    expect(b.id).toBe("b"); // new record inserted
    expect(b.reminder_status).toBe("active");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/reminder-pull.test.ts`
Expected: FAIL — cannot find module `../src/reminder-pull`.

- [ ] **Step 3: Implement `src/reminder-pull.ts`**

```ts
import { openInsaveDB, PENDING_STORE, getUserId } from "./db";
import { mergePulled } from "./reminder/reconcile-pull";
import type { PendingCapture } from "./types";

// Pull the user's tracked items from D1 and reconcile into IndexedDB: server-owned
// reminder state overlays local; device-owned content is kept; unknown rows inserted.
export async function pullAndReconcile(fetchFn: typeof fetch = fetch): Promise<void> {
  const userId = await getUserId();
  let res: Response;
  try {
    res = await fetchFn(`/api/pull?user_id=${encodeURIComponent(userId)}`);
  } catch {
    return; // offline — try again next launch
  }
  if (!res.ok) return;

  let items: PendingCapture[];
  try {
    items = ((await res.json()) as { items: PendingCapture[] }).items ?? [];
  } catch {
    return;
  }

  const db = await openInsaveDB();
  const tx = db.transaction(PENDING_STORE, "readwrite");
  for (const remote of items) {
    const local = (await tx.store.get(remote.id)) as PendingCapture | undefined;
    await tx.store.put(mergePulled(local, remote));
  }
  await tx.done;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/reminder-pull.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Create `review.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#111111" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <title>InSave — Review reminders</title>
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
      .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
      button { background: #2a2a2a; color: #eee; border: 1px solid #3a3a3a; border-radius: 6px; padding: 6px 12px; font-size: 14px; }
      button.done { background: #1e3a24; border-color: #2c573a; color: #b9f5c9; }
    </style>
  </head>
  <body>
    <header>
      <h1>Reels to revisit</h1>
      <p>The ones InSave is reminding you about. Mark them done, snooze, or open in Instagram.</p>
      <p><a href="/" style="color:#8ab4ff">← Back</a></p>
    </header>
    <div id="empty" class="empty">Nothing to revisit right now.</div>
    <div id="list"></div>
    <script type="module" src="/src/review-view.ts"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `src/review-view.ts`**

```ts
import { pullAndReconcile } from "./reminder-pull";
import { createPendingStore } from "./pending-store";
import { getUserId } from "./db";
import type { PendingCapture } from "./types";

const listEl = document.getElementById("list")!;
const emptyEl = document.getElementById("empty")!;

function authorLabel(item: PendingCapture): string {
  if (item.author) return "@" + item.author;
  try {
    return new URL(item.canonical_url).host;
  } catch {
    return "saved reel";
  }
}

async function postAction(userId: string, id: string, action: "done" | "snooze" | "open"): Promise<boolean> {
  try {
    const res = await fetch("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: userId, ids: [id], action }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  await pullAndReconcile();
  const userId = await getUserId();
  const store = await createPendingStore();
  const active = (await store.listByStatus("tagged")).concat(); // see note below
  // Reminder items are tagged items carrying reminder state; show the active pile.
  const items = active
    .filter((i) => i.reminder_status === "active")
    .sort((a, b) => {
      const rank = (x: PendingCapture) => (x.importance === "matters" ? 0 : 1);
      return rank(a) - rank(b) || (a.next_due_at ?? 0) - (b.next_due_at ?? 0);
    });

  if (items.length === 0) {
    emptyEl.classList.add("show");
    return;
  }
  for (const item of items) listEl.appendChild(renderCard(item, userId));
}

function renderCard(item: PendingCapture, userId: string): HTMLElement {
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
  if (item.parse_ok) link.addEventListener("click", () => { void postAction(userId, item.id, "open"); });
  card.appendChild(link);

  const controls = document.createElement("div");
  controls.className = "controls";

  const doneBtn = document.createElement("button");
  doneBtn.className = "done";
  doneBtn.textContent = "Done";
  doneBtn.addEventListener("click", async () => {
    doneBtn.disabled = true;
    if (await postAction(userId, item.id, "done")) {
      card.remove();
      if (listEl.children.length === 0) emptyEl.classList.add("show");
    } else {
      doneBtn.disabled = false;
      doneBtn.textContent = "Done (retry)";
    }
  });

  const snoozeBtn = document.createElement("button");
  snoozeBtn.textContent = "Snooze";
  snoozeBtn.addEventListener("click", async () => {
    snoozeBtn.disabled = true;
    if (await postAction(userId, item.id, "snooze")) {
      card.remove();
      if (listEl.children.length === 0) emptyEl.classList.add("show");
    } else {
      snoozeBtn.disabled = false;
      snoozeBtn.textContent = "Snooze (retry)";
    }
  });

  controls.appendChild(doneBtn);
  controls.appendChild(snoozeBtn);
  card.appendChild(controls);
  return card;
}

void main();
```

(Note: `.concat()` is a harmless no-op kept only so the variable name reads as a list copy; if a reviewer prefers, drop it — `store.listByStatus("tagged")` already returns a fresh array.)

- [ ] **Step 7: Add the `review` input to `vite.config.ts`**

In the `input` object, add after the `tag` line:

```ts
        tag: resolve(__dirname, "tag.html"),
        review: resolve(__dirname, "review.html"),
```

- [ ] **Step 8: Add `/review.html` to the SW shell and wire push actions + routing in `src/sw.ts`**

Change the `SHELL` line to include the review page:

```ts
const SHELL = ["/", "/index.html", "/captured.html", "/tag.html", "/review.html", "/manifest.webmanifest"];
```

Replace the `push` listener with one that adds Done/Snooze actions and carries `ids`/`user_id`:

```ts
self.addEventListener("push", (event: PushEvent) => {
  let data: { title: string; body: string; count: number; user_id?: string; ids?: string[] } = {
    title: "InSave", body: "Saved reels worth revisiting", count: 0,
  };
  try {
    if (event.data) data = { ...data, ...(event.data.json() as typeof data) };
  } catch {
    /* malformed payload — fall back to the default copy */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: "insave-digest",
      data,
      actions: [
        { action: "done", title: "Done" },
        { action: "snooze", title: "Snooze" },
      ],
    }),
  );
});
```

Replace the `notificationclick` listener with one that routes the action buttons to `/api/action` and a plain tap to the review view:

```ts
self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const data = (event.notification.data ?? {}) as { user_id?: string; ids?: string[] };

  if ((event.action === "done" || event.action === "snooze") && data.user_id && data.ids?.length) {
    event.waitUntil(
      fetch("/api/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: data.user_id, ids: data.ids, action: event.action }),
      }).then(() => undefined).catch(() => undefined),
    );
    return;
  }

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((c) => "focus" in c && "navigate" in c) as WindowClient | undefined;
      if (existing) {
        await existing.focus();
        return;
      }
      await self.clients.openWindow("/review.html");
    })(),
  );
});
```

- [ ] **Step 9: Add the review link to `index.html`**

After the `<p><button id="enable-reminders">Enable reminders</button></p>` line, add:

```html
      <p><a href="/review.html" style="color:#8ab4ff">Review reminders →</a></p>
```

- [ ] **Step 10: Run tests + type-check + build**

Run: `npx vitest run` then `npm run build`
Expected: all tests pass (incl. `pullAndReconcile`); `tsc` clean (SW `WindowClient`/`PushEvent`/`NotificationEvent` resolve from the `WebWorker` lib); Vite emits `review.html` + the `review` bundle. (The review-view DOM + SW handlers are verified on-device.)

- [ ] **Step 11: Commit**

```bash
git add src/reminder-pull.ts review.html src/review-view.ts vite.config.ts src/sw.ts index.html tests/reminder-pull.test.ts
git commit -m "feat: pullAndReconcile + review view + notification action routing (PRD 04c)"
```

---

### Task 6: Manual-verification doc + notes.md summary + lock spec

**Files:**
- Modify: `docs/manual-verification.md`
- Modify: `notes.md`
- Modify: `docs/superpowers/specs/2026-06-24-prd04c-reminder-interaction-design.md:8`

**Interfaces:**
- Consumes: the completed implementation.
- Produces: the manual checklist, the chronological PRD 04c summary, and a locked spec.

- [ ] **Step 1: Full verification gate**

Run: `npx vitest run` then `npm run build`
Expected: all tests green (record the count); `tsc` clean; build succeeds. Do NOT write the summary until this passes.

- [ ] **Step 2: Append the PRD 04c manual-verification section to `docs/manual-verification.md`**

```markdown

## PRD 04c — Reminder Interaction (review + pull + actions)

No schema changes; uses 04a/04b setup (reminder columns, VAPID, push_subscriptions).

### Checklist
- [ ] Open `/review.html` (or tap a notification) → the active reminder queue lists, matters-first; each card opens the reel in Instagram.
- [ ] Tap **Done** on a card → in D1 the item's `reminder_status='done'` and it leaves the queue on reload.
- [ ] Tap **Snooze** → `next_due_at` moves out, `reminder_status` stays `active`, the card leaves the list.
- [ ] Tap **Open in Instagram** → the reel opens and the item's `ignored_count` resets to 0 in D1.
- [ ] On the push notification, tap the **Done** / **Snooze** action button (app closed) → D1 reflects it for every item in the digest.
- [ ] Reinstall the PWA (clear site data) → open the app → `pullAndReconcile` restores the tracked items from D1 (no data loss).
- [ ] Re-pull after a local tag edit → the pull keeps the local tag/importance and does not resurrect a locally-dismissed item's content (reconciliation is no-clobber).
- [ ] `POST /api/action` with an unknown id is a no-op (200); a malformed body returns 400.
```

- [ ] **Step 3: Append the PRD 04c summary to `notes.md`**

Append a new `## PRD 04c — Reminder Interaction — 2026-06-24` section, same structure as the existing entries (What it is / Decisions made / How it works / Delivered (verified, with the real final test count + files from Step 1) / Still manual / open / Artifacts / Next PRDs). Note that this closes the PRD 04 core loop. Under "Still manual / open" list: the on-device review/action/reinstall checks; that a snoozed item can reappear in the pile before its deferred time (deferred refinement). Reference the spec + this plan under Artifacts. Set Next to "Core loop complete (PRD 01–04). Future: account transfer, per-tag scheduling, onboarding."

- [ ] **Step 4: Lock the design spec**

In `docs/superpowers/specs/2026-06-24-prd04c-reminder-interaction-design.md`, change line 8 `**Status:** Approved for planning` → `**Status:** Locked (implemented)`.

- [ ] **Step 5: Commit**

```bash
git add docs/manual-verification.md notes.md docs/superpowers/specs/2026-06-24-prd04c-reminder-interaction-design.md
git commit -m "docs: PRD 04c manual checklist + notes summary + lock spec"
```

---

## Self-Review notes (plan vs. spec)

- **Spec §3 action path** → Task 2 (`applyAction`) + Task 4 (`parseAction`, `/api/action`, `getById`).
- **§4 pull/reconcile** → Task 3 (`mergePulled`, `rowToPending`) + Task 4 (`listByUser`, `/api/pull`) + Task 5 (`pullAndReconcile`).
- **§5 notification actions** → Task 1 (`assemblePayload` ids+user_id) + Task 5 (SW push `actions` + `notificationclick` routing).
- **§6 review view** → Task 5 (`review.html`, `review-view.ts`, vite input, SW shell, index link).
- **§7 no schema change** → respected (no `schema.sql` edits). **§8 testing** → applyAction (T2), mergePulled+rowToPending (T3), assemblePayload (T1), parseAction/parsePull (T4), pullAndReconcile (T5); manual checklist (T6).
- **§9 acceptance** → covered across Tasks 1–5 + manual checklist (T6).
- **Type/name consistency:** `ReminderAction` defined in `src/reminder/action.ts` (T2), imported by `worker/index.ts` (T4); `applyAction(item, action, now)` signature identical in def + handler + test. `mergePulled(local, remote)` and `rowToPending(row)` identical in def, `d1-reminder-repo`, `reminder-pull`, and tests. `assemblePayload(userId, due)` updated in def (T1), caller `notify.ts` (T1), and test (T1). `parseAction`/`parsePull` exports match their test. Review view reads `reminder_status`/`importance`/`next_due_at` exactly as the model defines them.
- **No placeholders:** every code step has complete code; the one explanatory `.concat()` note is flagged as optional, not a gap.
