# PRD 05a — Collections: data model + sync foundation (design)

**Project:** InSave
**Parent PRD:** `PRD's/05-collections.md`
**Sibling (next):** PRD 05b — Collections UI (capture chips, collections home, cleanup view, backlog promote)
**Status:** Approved design, pre-plan
**Date:** 2026-06-25

---

## 0. Scope

PRD 05 is split into two phases (decision: 2026-06-25):

- **05a (this doc):** collection entity, `collection_id` on items, the always-present "Saved" default, item-move, and device-owned sync to D1 with pull-safety. All headless / TDD-clean. No DOM.
- **05b (next):** the zero-tap capture-chip surface, collections-as-home view, the cleanup view over "Saved", and backlog-promote → collection picker. Built on 05a.

05a delivers the foundation that 05b's UI sits on. Nothing in 05a changes user-visible behaviour on its own except that items now carry a (defaulted) collection and the data round-trips to D1.

## 1. Decisions carried in from brainstorming (2026-06-25)

- **Two phases:** 05a data+sync, 05b all UI.
- **`+ New collection` inline at capture:** a 05b concern; 05a only needs `create(name)` to exist.
- **No tag→collection migration:** existing items keep `topic_tags` as a hidden detail and all resolve to "Saved". No backfill.
- **Cleanup view:** built in 05b.

## 2. The load-bearing rule: `null` collection_id ≡ "Saved"

An item's `collection_id` is **nullable**. A `null`/`undefined` value **resolves to the user's "Saved" collection** everywhere it is read.

Consequences (all intentional):

- The zero-tap capture path writes **nothing extra** — an un-chosen capture has no `collection_id` and is therefore in "Saved" by definition. Preserves PRD 05 §1.
- **No migration:** every pre-existing item is already "in Saved" without touching it.
- An **explicit** assignment (a move, or a capture-time chip tap in 05b) writes a real id. Moving *to* Saved writes the Saved collection's id explicitly. Reads treat both `null` and `saved.id` as "Saved".

This rule is what keeps capture zero-write and the upgrade migration-free.

## 3. Data model

### 3.1 Types (`src/types.ts`)

New entity:

```ts
export interface Collection {
  id: string;          // client-generated UUID
  user_id: string;
  name: string;
  created_at: number;  // epoch ms
  is_default: boolean; // true ONLY for the per-user "Saved" collection
  synced: boolean;     // local-only flag, not a wire/D1 column
}
```

`PendingCapture` gains one field:

```ts
  collection_id?: string; // null/undefined ≡ the user's "Saved" collection
```

`collection_id` is a **device-owned content field** (like `topic_tags` / `importance`), distinct from the server-owned reminder-state columns.

### 3.2 IndexedDB (`src/db.ts`)

- Bump DB version **4 → 5**.
- Add object store `collections` (keyPath `id`) with index `by_user` on `user_id`.
- **No item migration** (null-is-Saved makes it unnecessary).
- Export `COLLECTIONS_STORE = "collections"`.

### 3.3 D1 (`schema.sql` + remote ALTER)

Fresh schema (`schema.sql`):

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

`pending_capture` gains a column:

```sql
ALTER TABLE pending_capture ADD COLUMN collection_id TEXT;  -- existing remote DB
CREATE INDEX IF NOT EXISTS idx_collection ON pending_capture (user_id, collection_id);
```

For a fresh DB, `collection_id TEXT` is added inline to the `pending_capture` `CREATE TABLE` and the index is created alongside the others.

Both the `ALTER` (existing remote) and the table/column creation (fresh) are documented in `docs/manual-verification.md` per the established migration pattern.

## 4. Storage layer

### 4.1 `src/collections-store.ts` (new)

A small store mirroring `pending-store.ts` conventions (shares `getUserId` for identity, `synced=false` on every write).

```ts
export interface CollectionsStore {
  ensureDefault(): Promise<Collection>;          // idempotent; mints "Saved" if absent
  list(): Promise<Collection[]>;                 // Saved first, then by created_at
  create(name: string): Promise<Collection>;     // is_default=false, synced=false
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;             // HARD-GUARD: refuses is_default
  listUnsynced(): Promise<Collection[]>;
  markSynced(ids: string[]): Promise<void>;
}
```

- `ensureDefault()` is called at store init. It looks up the user's `is_default` row; if none, it mints `{ id: uuid, user_id, name: "Saved", created_at: now, is_default: true, synced: false }`. Idempotent and safe under concurrent init (look-then-write inside one tx; a duplicate "Saved" must never be created).
- `remove()` **throws** on an `is_default` collection (a caller must never be able to delete "Saved" silently) — PRD 05 §7.1. Removing a non-default collection does **not** cascade-delete its items in 05a; item re-homing on collection delete is a 05b UI concern (out of scope here, noted so the plan doesn't silently drop items).

### 4.2 `src/pending-store.ts` additions

Extend the existing `PendingStore` interface:

```ts
  move(id: string, collection_id: string): Promise<void>;
  listByCollection(collectionId: string, savedId: string): Promise<PendingCapture[]>;
```

- `move` reuses the existing private `patch(id, { collection_id })` (sets `synced=false`, preserves `user_id`). One-at-a-time, idempotent.
- `listByCollection(collectionId, savedId)` returns items whose `collection_id === collectionId`, **plus** — when `collectionId === savedId` — items whose `collection_id` is null/undefined (the null-is-Saved rule). Sorted newest-first like `listByStatus`.

`capture.ts` is **unchanged**: a new capture has no `collection_id` and is thus in "Saved". (05b's chip tap will call `move`.)

## 5. Sync (device-owned, two rails)

### 5.1 `collection_id` on items → existing `POST /api/sync`

`collection_id` is a content field and rides the rail that already carries `topic_tags`/`importance`:

- `worker/index.ts`: add `collection_id?: string` to `WireRecord`; add the column to `UPSERT_SQL` (both the INSERT column list and the `ON CONFLICT(id) DO UPDATE SET` clause — newer local write wins, same as other content fields); add to `toBind`.
- Server-owned reminder columns remain untouched by this path (disjoint ownership holds).

### 5.2 Collections list → new `POST /api/collections`

A dedicated rail, mirroring `drainSync`:

- `src/collections-sync.ts` (new): `drainCollections(store, fetchFn)` — posts `store.listUnsynced()` as an array, marks accepted ids synced. Offline/!ok → no-op, retried next trigger (identical discipline to `drainSync`).
- `worker/index.ts`: handle `POST /api/collections` — UPSERT each row into `collections`:

```sql
INSERT INTO collections (id, user_id, name, created_at, is_default)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_default = excluded.is_default;
```

  Returns `{ accepted: string[] }` (same shape as `/api/sync`), with the same "accept only if genuinely stored" fallback.
- `GET /api/collections?user_id=` — returns `{ collections: [...] }` for durability/restore. (Full reinstall-restore *wiring* is a later concern — account transfer doesn't exist yet — but the endpoint + a repo method land here so collections are durable and restorable.)

### 5.3 Pull-safety (server pull must not clobber a local move)

- `src/reminder/reconcile-pull.ts` `mergePulled` **already** keeps all device-owned content and overwrites only the 5 reminder columns — so a `/api/pull` after a local move **cannot** clobber `collection_id`. Add a regression test asserting exactly this.
- The `!local` (fresh restore) branch returns `{ ...remote, synced: true }`, so `collection_id` must be present on the remote item. Therefore:
  - `worker/d1-reminder-repo.ts` `listByUser` SELECT must include `collection_id`.
  - `src/reminder/row-to-pending.ts` must map `collection_id` from the D1 row onto the `PendingCapture`.

## 6. Files touched (05a)

| File | Change |
|---|---|
| `src/types.ts` | add `Collection`; add `collection_id?` to `PendingCapture` |
| `src/db.ts` | v5 + `collections` store + `COLLECTIONS_STORE` export |
| `src/collections-store.ts` | **new** — collections CRUD + default-guard + unsynced/markSynced |
| `src/pending-store.ts` | add `move`, `listByCollection` to interface + impl |
| `src/collections-sync.ts` | **new** — `drainCollections` |
| `src/reminder/row-to-pending.ts` | map `collection_id` |
| `worker/index.ts` | `WireRecord`/`UPSERT_SQL`/`toBind` gain `collection_id`; `POST`+`GET /api/collections` |
| `worker/d1-reminder-repo.ts` | `listByUser` selects `collection_id`; add `listCollectionsByUser` + `upsertCollection` |
| `schema.sql` | `collections` table + `collection_id` col + indexes |
| `docs/manual-verification.md` | remote `ALTER`/`CREATE` migration steps |

## 7. Tests (TDD, all headless)

1. `collections-store`: `ensureDefault` idempotency (no duplicate Saved); `create`/`rename`/`list` (Saved-first ordering); `remove` hard-guard on default; `listUnsynced`/`markSynced`.
2. `pending-store`: `move` sets `collection_id` + `synced=false`; `listByCollection` returns explicit members AND null-is-Saved members only for the Saved id.
3. `collections-sync`: `drainCollections` posts unsynced, marks accepted, no-ops offline/!ok.
4. worker: `/api/collections` POST upsert + bad-payload 400; GET shape; `/api/sync` round-trips `collection_id`.
5. `reconcile-pull`: `mergePulled` preserves a locally-moved `collection_id` across a pull; `!local` restore carries `collection_id`.
6. `row-to-pending`: maps `collection_id`.

## 8. Acceptance (subset of PRD 05 §10 satisfiable headlessly in 05a)

- [ ] "Saved" always exists per user, is `is_default`, and cannot be deleted.
- [ ] Each item references exactly one collection, defaulting to "Saved" (via null-is-Saved).
- [ ] An item can be moved between collections; the change sets `synced=false` and round-trips via `/api/sync`.
- [ ] A pull does not clobber a newer local `collection_id` (mergePulled regression test).
- [ ] `collection_id` and the collections list sync to D1 as device-owned fields; reminder-state columns are untouched.
- [ ] Existing `topic_tags` preserved; no migration runs.

(UI-dependent ACs — zero-tap capture chip, collections-as-home, cleanup view, backlog picker — are 05b.)

## 9. Out of scope for 05a (→ 05b)

Capture-surface chips + inline "+ New"; collections-as-home view; move *UI*; cleanup view over Saved; backlog-promote picker; SW redirect carrying the record id; on-delete item re-homing UX.
