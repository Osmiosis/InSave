# PRD 05a — Collections data + sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-user "Collection" entity, a `collection_id` on every item (null ≡ "Saved"), item-move, and device-owned sync of both to D1 — all headless, with pull-safety so a server pull can't clobber a local move.

**Architecture:** Collections live in their own IndexedDB store + D1 `collections` table, synced on a dedicated `/api/collections` rail mirroring `drainSync`. `collection_id` is a content field on `pending_capture` that rides the existing `/api/sync` UPSERT. A `null` `collection_id` resolves to the user's "Saved" default everywhere it's read, so capture stays zero-write and no migration runs. The existing `mergePulled` already keeps device-owned content on pull; we only add a mapping + regression test.

**Tech Stack:** TypeScript, IndexedDB via `idb`, Cloudflare D1, Vitest + `fake-indexeddb`. No new dependencies.

## Global Constraints

- **No new runtime dependencies.** Use only what's already in `package.json`.
- **`collection_id` null/undefined ≡ the user's "Saved" collection** — read everywhere by this rule; never backfilled onto existing items.
- **"Saved" is `is_default`, one per user, undeletable** — `remove()` of a default MUST throw.
- **Device-owned content fields only.** This phase NEVER reads or writes the five server-owned reminder columns (`reminder_status`, `next_due_at`, `cycle_count`, `ignored_count`, `last_surfaced_at`).
- **Sync discipline (mirror `drainSync`):** post unsynced → mark only `accepted` ids → offline/`!res.ok`/throw = no-op, retried next trigger.
- **Every write sets `synced: false`** and preserves an existing `user_id`.
- **Run the full suite** (`npx vitest run`) at each task's verify step; it must stay fully green (117 tests at branch start).

---

### Task 1: Collection entity — types, IndexedDB v5, collections-store

**Files:**
- Modify: `src/types.ts` (add `Collection`; add `collection_id?` to `PendingCapture`)
- Modify: `src/db.ts` (bump to v5, add `collections` store + `COLLECTIONS_STORE` export)
- Create: `src/collections-store.ts`
- Test: `tests/collections-store.test.ts`

**Interfaces:**
- Consumes: `openInsaveDB`, `getUserId`, `META_STORE` from `./db`.
- Produces:
  - `Collection { id: string; user_id: string; name: string; created_at: number; is_default: boolean; synced: boolean }`
  - `CollectionsStore { ensureDefault(): Promise<Collection>; list(): Promise<Collection[]>; create(name: string): Promise<Collection>; rename(id: string, name: string): Promise<void>; remove(id: string): Promise<void>; listUnsynced(): Promise<Collection[]>; markSynced(ids: string[]): Promise<void> }`
  - `createCollectionsStore(now?, uuid?): Promise<CollectionsStore>` — ensures the "Saved" default exists before returning.
  - `COLLECTIONS_STORE = "collections"` from `./db`.

- [ ] **Step 1: Write the failing test** — `tests/collections-store.test.ts`

```ts
import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { indexedDB } from "fake-indexeddb";
import { createCollectionsStore } from "../src/collections-store";

// Incrementing uuid so the minted user_id and each collection id are distinct.
function counter(prefix = "c") {
  let n = 0;
  return () => `${prefix}${n++}`;
}

describe("collections-store", () => {
  beforeEach(async () => {
    await new Promise<void>((res) => {
      const del = indexedDB.deleteDatabase("insave");
      del.onsuccess = () => res();
      del.onerror = () => res();
    });
  });

  it("ensures a single undeletable Saved default on creation", async () => {
    const store = await createCollectionsStore(() => 1000, counter());
    const all = await store.list();
    const defaults = all.filter((c) => c.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].name).toBe("Saved");
  });

  it("ensureDefault is idempotent (never a second Saved)", async () => {
    const store = await createCollectionsStore(() => 1000, counter());
    await store.ensureDefault();
    await store.ensureDefault();
    expect((await store.list()).filter((c) => c.is_default)).toHaveLength(1);
  });

  it("create adds a non-default, unsynced collection; list puts Saved first", async () => {
    const store = await createCollectionsStore(() => 1000, counter());
    const recipes = await store.create("Recipes");
    expect(recipes.is_default).toBe(false);
    expect(recipes.synced).toBe(false);
    const names = (await store.list()).map((c) => c.name);
    expect(names[0]).toBe("Saved");
    expect(names).toContain("Recipes");
  });

  it("rename changes the name and marks unsynced", async () => {
    const store = await createCollectionsStore(() => 1000, counter());
    const c = await store.create("Gymm");
    await store.markSynced([c.id]);
    await store.rename(c.id, "Gym");
    const found = (await store.list()).find((x) => x.id === c.id)!;
    expect(found.name).toBe("Gym");
    expect(found.synced).toBe(false);
  });

  it("remove deletes a normal collection but throws on the default", async () => {
    const store = await createCollectionsStore(() => 1000, counter());
    const c = await store.create("Temp");
    await store.remove(c.id);
    expect((await store.list()).some((x) => x.id === c.id)).toBe(false);
    const saved = (await store.list()).find((x) => x.is_default)!;
    await expect(store.remove(saved.id)).rejects.toThrow();
  });

  it("listUnsynced returns only unsynced; markSynced clears them", async () => {
    const store = await createCollectionsStore(() => 1000, counter());
    const a = await store.create("A");
    await store.markSynced([a.id]);
    const b = await store.create("B");
    const unsynced = await store.listUnsynced();
    expect(unsynced.map((c) => c.name)).toContain("B");
    expect(unsynced.map((c) => c.name)).not.toContain("A");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/collections-store.test.ts`
Expected: FAIL — cannot find module `../src/collections-store`.

- [ ] **Step 3: Add the `Collection` type and `collection_id`** — edit `src/types.ts`

Add `collection_id?: string;` to the `PendingCapture` interface, right after the `tagged_at` line (with the Tag Queue block):

```ts
  tagged_at?: number;    // epoch ms, set on transition to "tagged"
  // Collections (PRD 05). null/undefined ≡ the user's "Saved" collection.
  collection_id?: string;
```

Add the new interface near `UserSettings` (before the final `export type { PendingStore }` line):

```ts
export interface Collection {
  id: string;            // client-generated UUID
  user_id: string;
  name: string;
  created_at: number;    // epoch ms
  is_default: boolean;   // true ONLY for the per-user "Saved" collection
  synced: boolean;       // local-only flag, not a wire/D1 column
}
```

- [ ] **Step 4: Bump IndexedDB to v5** — edit `src/db.ts`

Add the export beside the other store-name constants:

```ts
export const COLLECTIONS_STORE = "collections";
```

Change the version `4` to `5` in `openDB(DB_NAME, 5, {` and add the upgrade branch after the `oldVersion < 4` block:

```ts
      if (oldVersion < 5) {
        const os = database.createObjectStore(COLLECTIONS_STORE, { keyPath: "id" });
        os.createIndex("by_user", "user_id", { unique: false });
      }
```

- [ ] **Step 5: Implement `src/collections-store.ts`**

```ts
import { openInsaveDB, COLLECTIONS_STORE, getUserId } from "./db";
import type { Collection } from "./types";

export interface CollectionsStore {
  ensureDefault(): Promise<Collection>;
  list(): Promise<Collection[]>;
  create(name: string): Promise<Collection>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
  listUnsynced(): Promise<Collection[]>;
  markSynced(ids: string[]): Promise<void>;
}

export async function createCollectionsStore(
  now: () => number = () => Date.now(),
  uuid: () => string = () => crypto.randomUUID(),
): Promise<CollectionsStore> {
  const db = await openInsaveDB();
  const userId = await getUserId(uuid); // shared identity (meta store), same as pending-store

  async function listAll(): Promise<Collection[]> {
    const all = (await db.getAllFromIndex(COLLECTIONS_STORE, "by_user", userId)) as Collection[];
    // Saved (default) first, then oldest-created first.
    return all.sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.created_at - b.created_at);
  }

  async function ensureDefault(): Promise<Collection> {
    const existing = (await listAll()).find((c) => c.is_default);
    if (existing) return existing;
    const def: Collection = {
      id: uuid(), user_id: userId, name: "Saved",
      created_at: now(), is_default: true, synced: false,
    };
    await db.put(COLLECTIONS_STORE, def);
    return def;
  }

  await ensureDefault();

  return {
    ensureDefault,
    list: listAll,
    async create(name) {
      const c: Collection = {
        id: uuid(), user_id: userId, name,
        created_at: now(), is_default: false, synced: false,
      };
      await db.put(COLLECTIONS_STORE, c);
      return c;
    },
    async rename(id, name) {
      const tx = db.transaction(COLLECTIONS_STORE, "readwrite");
      const c = (await tx.store.get(id)) as Collection | undefined;
      if (c) await tx.store.put({ ...c, name, synced: false });
      await tx.done;
    },
    async remove(id) {
      const c = (await db.get(COLLECTIONS_STORE, id)) as Collection | undefined;
      if (c?.is_default) throw new Error("cannot delete the default collection");
      await db.delete(COLLECTIONS_STORE, id);
    },
    async listUnsynced() {
      return (await listAll()).filter((c) => !c.synced);
    },
    async markSynced(ids) {
      const tx = db.transaction(COLLECTIONS_STORE, "readwrite");
      for (const id of ids) {
        const c = (await tx.store.get(id)) as Collection | undefined;
        if (c) await tx.store.put({ ...c, synced: true });
      }
      await tx.done;
    },
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/collections-store.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all tests green (117 prior + 6 new = 123).

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/db.ts src/collections-store.ts tests/collections-store.test.ts
git commit -m "feat(prd05a): Collection entity, IndexedDB v5, collections-store"
```

---

### Task 2: Item membership — pending-store `move` + `listByCollection`

**Files:**
- Modify: `src/pending-store.ts` (interface + impl)
- Modify: `tests/pending-store.test.ts` (add cases)
- Modify: `tests/sync.test.ts` (extend mock literal — interface grew)
- Modify: `tests/capture.test.ts` (extend mock literal — interface grew)

**Interfaces:**
- Consumes: existing `PendingStore`, the private `patch(id, fields)` in `pending-store.ts`.
- Produces, added to `PendingStore`:
  - `move(id: string, collection_id: string): Promise<void>` — sets `collection_id`, `synced=false`.
  - `listByCollection(collectionId: string, savedId: string): Promise<PendingCapture[]>` — members whose `collection_id === collectionId`, plus (only when `collectionId === savedId`) items with null/undefined `collection_id`. Newest-first.

- [ ] **Step 1: Write the failing test** — append to `tests/pending-store.test.ts` (inside the `describe`)

```ts
  it("move sets collection_id and marks unsynced", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a", synced: true }));
    await store.move("a", "col-recipes");
    const r = await store.getByCanonicalUrl("u-a");
    expect(r?.collection_id).toBe("col-recipes");
    expect(r?.synced).toBe(false);
  });

  it("listByCollection returns explicit members", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a", collection_id: "col-x" }));
    await store.put(rec({ id: "b", canonical_url: "u-b", collection_id: "col-y" }));
    const xs = await store.listByCollection("col-x", "saved-id");
    expect(xs.map((r) => r.id)).toEqual(["a"]);
  });

  it("listByCollection treats null collection_id as Saved, newest first", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a", captured_at: 100 }));               // null -> Saved
    await store.put(rec({ id: "b", canonical_url: "u-b", captured_at: 300 }));               // null -> Saved
    await store.put(rec({ id: "c", canonical_url: "u-c", captured_at: 200, collection_id: "saved-id" })); // explicit Saved
    await store.put(rec({ id: "d", canonical_url: "u-d", captured_at: 400, collection_id: "col-x" }));    // elsewhere
    const saved = await store.listByCollection("saved-id", "saved-id");
    expect(saved.map((r) => r.id)).toEqual(["b", "c", "a"]); // 300, 200, 100; d excluded
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pending-store.test.ts`
Expected: FAIL — `store.move is not a function` / `listByCollection is not a function`.

- [ ] **Step 3: Extend the `PendingStore` interface** — edit `src/pending-store.ts`

Add to the `PendingStore` interface (after `restore`):

```ts
  move(id: string, collection_id: string): Promise<void>;
  listByCollection(collectionId: string, savedId: string): Promise<PendingCapture[]>;
```

- [ ] **Step 4: Implement the two methods** — in the returned object of `createPendingStore`, after `restore`:

```ts
    async move(id, collection_id) {
      await patch(id, { collection_id });
    },
    async listByCollection(collectionId, savedId) {
      const all = (await db.getAll(PENDING_STORE)) as PendingCapture[];
      const includeNull = collectionId === savedId;
      return all
        .filter((r) => r.collection_id === collectionId || (includeNull && r.collection_id == null))
        .sort((a, b) => b.captured_at - a.captured_at);
    },
```

- [ ] **Step 5: Fix the broken mock literals** (interface grew → these object literals no longer satisfy `PendingStore`)

In `tests/sync.test.ts`, inside `storeWith`'s returned object (after `async restore() {},`):

```ts
    async move() {},
    async listByCollection() { return []; },
```

In `tests/capture.test.ts`, in its `PendingStore` mock object (after its `restore`/`listDistinctTags` stubs), add the same two stubs:

```ts
    async move() {},
    async listByCollection() { return []; },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/pending-store.test.ts tests/sync.test.ts tests/capture.test.ts`
Expected: PASS (new pending-store cases green; sync + capture suites still green).

- [ ] **Step 7: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all green.

- [ ] **Step 8: Commit**

```bash
git add src/pending-store.ts tests/pending-store.test.ts tests/sync.test.ts tests/capture.test.ts
git commit -m "feat(prd05a): pending-store move + listByCollection (null-is-Saved)"
```

---

### Task 3: `collection_id` on the `/api/sync` rail (worker UPSERT)

**Files:**
- Modify: `worker/index.ts` (`WireRecord`, `UPSERT_SQL`, `toBind`)
- Modify: `tests/worker-sync.test.ts` (add cases)

**Interfaces:**
- Consumes: existing `WireRecord`, `UPSERT_SQL`, `toBind`.
- Produces: `collection_id` becomes column **18** (bind index `[17]`), appended after `user_id` so existing bind indices `[0]..[16]` are unchanged.

- [ ] **Step 1: Write the failing test** — append to `tests/worker-sync.test.ts` (inside the `describe`)

```ts
  it("carries collection_id as a device-owned content column", () => {
    expect(UPSERT_SQL).toContain("collection_id = excluded.collection_id");
    expect(toBind(wire({ collection_id: "col-x" }))[17]).toBe("col-x");
  });

  it("binds null when collection_id is absent (null-is-Saved)", () => {
    expect(toBind(wire())[17]).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/worker-sync.test.ts`
Expected: FAIL — `UPSERT_SQL` lacks `collection_id`; `toBind(...)[17]` is `undefined`.

- [ ] **Step 3: Add `collection_id` to `WireRecord`** — edit `worker/index.ts`, in the `WireRecord` interface after `user_id?: string;`:

```ts
  user_id?: string;
  collection_id?: string;
```

- [ ] **Step 4: Add the column to `UPSERT_SQL`** — append `collection_id` to the INSERT column list, add one `?`, and add the `ON CONFLICT` line. The new constant:

```ts
export const UPSERT_SQL = `INSERT INTO pending_capture
   (id, canonical_url, raw_payload, captured_at, source, status, parse_ok,
    saved_at, title, thumbnail, description, topic_tags, importance, tagged_at, author, media_type,
    user_id, collection_id)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
   collection_id = excluded.collection_id`;
```

- [ ] **Step 5: Append `collection_id` to `toBind`** — add as the final array element (after `r.user_id ?? null,`):

```ts
    r.user_id ?? null,
    r.collection_id ?? null,
  ];
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/worker-sync.test.ts`
Expected: PASS — including the unchanged `[11]..[16]` index assertions (collection_id appended after, so they don't shift).

- [ ] **Step 7: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all green.

- [ ] **Step 8: Commit**

```bash
git add worker/index.ts tests/worker-sync.test.ts
git commit -m "feat(prd05a): sync collection_id on the device-owned /api/sync rail"
```

---

### Task 4: Pull-safety — map `collection_id` on restore, regression-test mergePulled

**Files:**
- Modify: `src/reminder/row-to-pending.ts` (map `collection_id`)
- Modify: `tests/reminder/row-to-pending.test.ts` (add case)
- Modify: `tests/reminder/reconcile-pull.test.ts` (add preservation case)

Note: `worker/d1-reminder-repo.ts` `listByUser`/`getById` use `SELECT *`, so the new `collection_id` column is already selected once it exists — no repo change needed. `mergePulled` already keeps all device-owned content, so it needs **no code change**, only a regression test asserting it.

**Interfaces:**
- Consumes: `rowToPending(row)`, `mergePulled(local, remote)`.
- Produces: `rowToPending` output now carries `collection_id` (`str(row.collection_id)`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/reminder/row-to-pending.test.ts` (inside its `describe`):

```ts
  it("maps collection_id from the row", () => {
    const p = rowToPending({ id: "a", canonical_url: "u", raw_payload: "{}", captured_at: 1, source: "import", status: "tagged", parse_ok: 1, collection_id: "col-x" });
    expect(p.collection_id).toBe("col-x");
  });

  it("leaves collection_id undefined when the column is null (null-is-Saved)", () => {
    const p = rowToPending({ id: "a", canonical_url: "u", raw_payload: "{}", captured_at: 1, source: "import", status: "tagged", parse_ok: 1, collection_id: null });
    expect(p.collection_id).toBeUndefined();
  });
```

Append to `tests/reminder/reconcile-pull.test.ts` (inside its `describe`):

```ts
  it("does not clobber a newer local collection_id on pull", () => {
    const local = rec({ collection_id: "col-local", reminder_status: "active", synced: false });
    const remote = rec({ collection_id: "col-stale-server", reminder_status: "expired", next_due_at: 99 });
    const merged = mergePulled(local, remote);
    expect(merged.collection_id).toBe("col-local"); // device-owned content kept
    expect(merged.reminder_status).toBe("expired"); // server-owned overlaid
  });

  it("restore (!local) carries collection_id from remote", () => {
    const remote = rec({ collection_id: "col-restored" });
    expect(mergePulled(undefined, remote).collection_id).toBe("col-restored");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/reminder/row-to-pending.test.ts tests/reminder/reconcile-pull.test.ts`
Expected: the `row-to-pending` "maps collection_id" case FAILS (`undefined`); the reconcile "does not clobber" case FAILS (merged is `col-stale-server`, because `local` doesn't carry it through `rowToPending` — but here `rec()` sets it directly, so this one actually depends only on mergePulled spreading `...local`; it should PASS already). Confirm which fail; at minimum the row-to-pending mapping fails.

- [ ] **Step 3: Map `collection_id` in `rowToPending`** — edit `src/reminder/row-to-pending.ts`, add to the returned object (after `tagged_at: num(row.tagged_at),`):

```ts
    tagged_at: num(row.tagged_at),
    collection_id: str(row.collection_id),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/reminder/row-to-pending.test.ts tests/reminder/reconcile-pull.test.ts`
Expected: PASS (mapping + both reconcile cases).

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all green.

- [ ] **Step 6: Commit**

```bash
git add src/reminder/row-to-pending.ts tests/reminder/row-to-pending.test.ts tests/reminder/reconcile-pull.test.ts
git commit -m "feat(prd05a): carry collection_id through pull/restore; mergePulled regression"
```

---

### Task 5: Collections-list sync rail — `drainCollections` + `/api/collections`

**Files:**
- Create: `src/collections-sync.ts`
- Create: `tests/collections-sync.test.ts`
- Modify: `worker/index.ts` (export `COLLECTIONS_UPSERT_SQL` + `parseCollections`; add `handleCollections`; route POST/GET `/api/collections`)
- Create: `tests/worker-collections.test.ts`

**Interfaces:**
- Consumes: `CollectionsStore` (`listUnsynced`, `markSynced`) from Task 1.
- Produces:
  - `drainCollections(store: Pick<CollectionsStore, "listUnsynced" | "markSynced">, fetchFn?): Promise<void>`
  - Worker exports `COLLECTIONS_UPSERT_SQL: string`, `parseCollections(body: unknown): CollectionWire[] | null`.
  - Routes: `POST /api/collections` (upsert, returns `{accepted}`), `GET /api/collections?user_id=` (returns `{collections}`).

- [ ] **Step 1: Write the failing client test** — `tests/collections-sync.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import { drainCollections } from "../src/collections-sync";
import type { Collection } from "../src/types";

function col(id: string): Collection {
  return { id, user_id: "u1", name: id, created_at: 1, is_default: false, synced: false };
}

function storeWith(unsynced: Collection[]) {
  const marked: string[] = [];
  return {
    marked,
    async listUnsynced() { return unsynced; },
    async markSynced(ids: string[]) { marked.push(...ids); },
  };
}

describe("drainCollections", () => {
  it("posts unsynced collections and marks accepted ids synced", async () => {
    const store = storeWith([col("a"), col("b")]);
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ accepted: ["a", "b"] }), { status: 200 }));
    await drainCollections(store, fetchFn as unknown as typeof fetch);
    const [url, init] = (fetchFn.mock.calls[0] as [string, RequestInit]);
    expect(url).toBe("/api/collections");
    const sent = JSON.parse(init.body as string);
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toHaveProperty("synced"); // local-only flag stripped
    expect(store.marked.sort()).toEqual(["a", "b"]);
  });

  it("does nothing when nothing is unsynced", async () => {
    const store = storeWith([]);
    const fetchFn = vi.fn();
    await drainCollections(store, fetchFn as unknown as typeof fetch);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not mark synced on throw or non-ok", async () => {
    const s1 = storeWith([col("a")]);
    await drainCollections(s1, (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    expect(s1.marked).toEqual([]);
    const s2 = storeWith([col("a")]);
    await drainCollections(s2, (async () => new Response("err", { status: 500 })) as unknown as typeof fetch);
    expect(s2.marked).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/collections-sync.test.ts`
Expected: FAIL — cannot find module `../src/collections-sync`.

- [ ] **Step 3: Implement `src/collections-sync.ts`**

```ts
import type { Collection } from "./types";

interface SyncableCollections {
  listUnsynced(): Promise<Collection[]>;
  markSynced(ids: string[]): Promise<void>;
}

// Drop the local-only `synced` flag before sending.
function toWire(c: Collection) {
  const { synced, ...wire } = c;
  void synced;
  return wire;
}

export async function drainCollections(
  store: SyncableCollections,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const unsynced = await store.listUnsynced();
  if (unsynced.length === 0) return;

  let res: Response;
  try {
    res = await fetchFn("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(unsynced.map(toWire)),
    });
  } catch {
    return; // offline — retry next trigger
  }
  if (!res.ok) return;

  let accepted: string[];
  try {
    accepted = ((await res.json()) as { accepted: string[] }).accepted ?? [];
  } catch {
    return;
  }
  if (accepted.length) await store.markSynced(accepted);
}
```

- [ ] **Step 4: Run the client test to verify it passes**

Run: `npx vitest run tests/collections-sync.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing worker test** — `tests/worker-collections.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { COLLECTIONS_UPSERT_SQL, parseCollections } from "../worker/index";

describe("worker collections rail", () => {
  it("upserts mutable columns on id conflict but not identity columns", () => {
    expect(COLLECTIONS_UPSERT_SQL).toContain("ON CONFLICT(id) DO UPDATE SET");
    expect(COLLECTIONS_UPSERT_SQL).toContain("name = excluded.name");
    expect(COLLECTIONS_UPSERT_SQL).toContain("is_default = excluded.is_default");
    const update = COLLECTIONS_UPSERT_SQL.slice(COLLECTIONS_UPSERT_SQL.indexOf("DO UPDATE SET"));
    for (const col of ["id", "user_id", "created_at"]) {
      expect(update).not.toContain(`${col} = excluded.${col}`);
    }
  });

  it("parseCollections accepts a valid array and rejects junk", () => {
    const ok = parseCollections([
      { id: "a", user_id: "u", name: "Saved", created_at: 1, is_default: true },
    ]);
    expect(ok).toHaveLength(1);
    expect(parseCollections({})).toBeNull();
    expect(parseCollections([{ id: "a" }])).toBeNull(); // missing required fields
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run tests/worker-collections.test.ts`
Expected: FAIL — `COLLECTIONS_UPSERT_SQL` / `parseCollections` not exported.

- [ ] **Step 7: Implement the worker rail** — edit `worker/index.ts`

Add a wire type + exports near `UPSERT_SQL`:

```ts
interface CollectionWire {
  id: string; user_id: string; name: string; created_at: number; is_default: boolean;
}

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
```

Add the routes in `fetch` (before the final `return new Response("Not found", …)`):

```ts
    if (request.method === "POST" && url.pathname === "/api/collections") {
      return handleCollections(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/collections") {
      return handleCollectionsPull(url, env);
    }
```

Add the two handlers (after `handleSync`):

```ts
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
```

- [ ] **Step 8: Run the worker test to verify it passes**

Run: `npx vitest run tests/worker-collections.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all green.

- [ ] **Step 10: Commit**

```bash
git add src/collections-sync.ts tests/collections-sync.test.ts worker/index.ts tests/worker-collections.test.ts
git commit -m "feat(prd05a): collections-list sync rail (drainCollections + /api/collections)"
```

---

### Task 6: D1 schema + migration docs

**Files:**
- Modify: `schema.sql`
- Modify: `docs/manual-verification.md`

No vitest coverage (D1 DDL isn't exercised by the headless suite). Verify by applying the schema to a local D1.

- [ ] **Step 1: Edit `schema.sql`**

Add `collection_id TEXT` to the `pending_capture` `CREATE TABLE`, immediately after the `last_surfaced_at INTEGER` line (before the closing `);`):

```sql
  last_surfaced_at INTEGER,
  collection_id    TEXT
);
```

After the existing `idx_due` index, add:

```sql
CREATE INDEX IF NOT EXISTS idx_collection
  ON pending_capture (user_id, collection_id);
```

After the `push_subscriptions` block (before the `idx_canonical_url` partial index, order is not significant), add the collections table:

```sql
CREATE TABLE IF NOT EXISTS collections (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_collections_user ON collections (user_id);
```

- [ ] **Step 2: Verify the schema parses/applies to a local D1**

Run: `npx wrangler d1 execute insave --local --file=./schema.sql --yes`
Expected: "Executed N commands" with no SQL error (local miniflare D1; no network/auth). If `--yes` is unrecognized on the pinned wrangler 3.114.17, rerun without it.

- [ ] **Step 3: Document the remote migration** — append to `docs/manual-verification.md` under the migration/schema section, a "PRD 05a" subsection:

```markdown
### PRD 05a — Collections (remote D1 migration)

Apply once against the deployed DB (existing rows untouched; `collection_id` null ≡ "Saved"):

    npx wrangler d1 execute insave --remote --command \
      "ALTER TABLE pending_capture ADD COLUMN collection_id TEXT;"
    npx wrangler d1 execute insave --remote --command \
      "CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, is_default INTEGER NOT NULL DEFAULT 0);"
    npx wrangler d1 execute insave --remote --command \
      "CREATE INDEX IF NOT EXISTS idx_collections_user ON collections (user_id);"
    npx wrangler d1 execute insave --remote --command \
      "CREATE INDEX IF NOT EXISTS idx_collection ON pending_capture (user_id, collection_id);"
```

- [ ] **Step 4: Commit**

```bash
git add schema.sql docs/manual-verification.md
git commit -m "chore(prd05a): D1 collections table + collection_id column + migration docs"
```

---

## Final verification (after all tasks)

- [ ] `npx tsc --noEmit` — clean.
- [ ] `npx vitest run` — all green (117 baseline + new: collections-store 6, pending-store 3, worker-sync 2, row-to-pending 2, reconcile-pull 2, collections-sync 3, worker-collections 2 ≈ 137).
- [ ] `npx vite build` — production build succeeds (no broken imports in the bundle).
- [ ] Spec acceptance (§8) re-read against the diff; UI-dependent ACs explicitly deferred to 05b.

## Spec coverage map

| Spec §8 acceptance | Task |
|---|---|
| "Saved" always exists, is_default, undeletable | 1 |
| Each item references one collection, defaults to "Saved" (null-is-Saved) | 1, 2 |
| Item move sets synced=false, round-trips via /api/sync | 2, 3 |
| Pull doesn't clobber newer local collection_id | 4 |
| collection_id + collections list sync to D1 as device-owned; reminder cols untouched | 3, 5 |
| Existing topic_tags preserved; no migration | 1 (no backfill), 2 |
