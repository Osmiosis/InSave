# PRD 05b — Collections UI (design)

**Project:** InSave
**Parent PRD:** `PRD's/05-collections.md`
**Sibling (prior):** PRD 05a — Collections data + sync foundation (complete)
**Status:** Approved design, pre-plan
**Date:** 2026-06-25

---

## 0. Scope

PRD 05 was split 05a (data+sync) / 05b (UI). 05a is done and headless-clean. 05b builds the
user-facing surfaces on top of it.

**This spec (05b) ships the "core slice" (decision 2026-06-25):**

- **A — Collections home:** the app's primary view becomes the list of collections (name + count),
  opening one lists its reels.
- **B — Capture-chip surface:** `captured.html` offers one-tap assignment to an existing collection,
  preserving the zero-tap default.
- **E — Create / rename / delete collections:** management from the home view.
- **Move** a reel between collections (from the detail view).
- **Wiring:** `drainCollections` runs alongside `drainSync`; `createCollectionsStore()` (ensuring
  "Saved") runs on app open.

**Deferred to a later 05c:**

- **C — Cleanup view** over "Saved" (the demoted tag queue).
- **D — Backlog-promote** collection picker (PRD 02 import flow).

These are PRD 05 acceptance items but §12 explicitly flags them as deferrable; the demotion of
tagging stands regardless. `tag.html` / `tag-view.ts` are left untouched in 05b (they become the
basis for 05c's cleanup view).

## 1. Decisions carried in from brainstorming (2026-06-25)

- **index.html *becomes* the collections home** (it is already `start_url="/"` and in the SW SHELL).
  No separate `collections.html`. A compact header retains the existing Import / Review / Enable-
  reminders entry points so nothing is lost.
- **Capture chips pick existing collections only** (PRD §12 lean: "pick existing at capture; create
  in-app"). The capture surface offers a "+ New in app" deep-link to the home, not an inline create.
- **Capture surface is progressive enhancement.** The durable save to "Saved" already happens inside
  the SW before the redirect, so chips are pure enhancement: if the module never loads (offline
  before the bundle is cached), the inline "Saved ✓" toast still shows and the reel is correctly in
  "Saved". The zero-tap guarantee holds regardless of how the page loads.
- **Deleting a non-empty collection prompts** a three-way choice: *Move reels to Saved* (re-home),
  *Delete reels too* (= `dismiss`, recoverable, syncs as `status='dismissed'`; InSave has no hard-
  delete rail and does not gain one here), or *Cancel*. Empty collections delete with no prompt.
- **Chip ordering: newest-created first**, capped at 5, excluding the default "Saved" (the reel is
  already in Saved). No last-used signal exists yet; PRD §12 says tune later.
- **`dismiss` for "delete reels"**: reuses the existing `status='dismissed'` content field, which
  already round-trips on `/api/sync`. No new endpoint, no destructive D1 delete.

## 2. The load-bearing invariant (unchanged from 05a)

`collection_id` null/undefined ≡ the user's "Saved" collection. Every read in 05b honours this:

- Opening "Saved" lists items whose `collection_id === saved.id` **and** items with null/undefined
  `collection_id` (via 05a's `listByCollection(savedId, savedId)`).
- The home count for "Saved" includes the null-collection items.
- Capture writes nothing extra; a reel only gains an explicit `collection_id` when a chip is tapped
  or it is moved.

## 3. Surfaces

### 3.1 Collections home — `index.html` + `src/collections-home.ts` (A, E)

Replaces the current launcher content. Renders:

- A compact **header** with the app name and small links: `Import`, `Review`, `Enable reminders`
  (reusing `push-enable.ts`'s button), so the prior launcher affordances survive.
- A **"+ New collection"** control → prompts for a name → `collectionsStore.create(name)` →
  re-render. Empty/whitespace name is a no-op.
- A **list of collection cards**, "Saved" first (then by `created_at`, matching
  `collectionsStore.list()` order). Each card shows:
  - the collection **name**,
  - an **active-reel count** = members with `status !== 'dismissed'` (computed via
    `pending-store.listByCollection(col.id, saved.id)` then filtered),
  - for **non-default** collections only: a **rename** affordance (prompt → `rename`) and a
    **delete** affordance (§3.4 flow). "Saved" shows neither (it is undeletable; rename is out of
    scope — keep the system name stable).
- Tapping a card navigates to `collection.html?id=<id>`.

On load: `createCollectionsStore()` (ensures "Saved" exists before first render) and
`createPendingStore()`, then a fire-and-forget `drainAll()` (§3.5).

### 3.2 Collection detail — `collection.html?id=<id>` + `src/collection-view.ts` (A, move)

- Reads the `id` from the query string; resolves the collection from `collectionsStore.list()`
  (and `saved` = the `is_default` row). An unknown/missing id falls back to "Saved".
- Lists reels via `listByCollection(id, saved.id)`, filtered to `status !== 'dismissed'`,
  newest-first (the store already sorts by `captured_at` desc).
- Each reel reuses the **existing card layout** (author/host label, media-type badge, caption,
  `Open in Instagram ↗`) from `tag-view`/`review-view`, optionally factored into `reel-card.ts` so
  the detail view (and 05c's cleanup view later) share one renderer. The home view renders
  *collection* cards and the capture surface renders *chips* — neither uses the reel card.
- Each card has a **Move** action → opens the shared **collection-picker** (§3.3) → on pick,
  `pending-store.move(reel.id, targetId)` → `drainAll()` (fire-and-forget) → the card leaves the
  current list (animates out); a "Moved to X" undo toast (reuse the `tag-view` toast pattern) calls
  `move(reel.id, originalId)` on undo.
- Empty state: "Nothing here yet."

### 3.3 Shared collection picker — `src/collection-picker.ts` (A, B)

One module, two presentations over the same data:

- `pickerSheet(collections, { exclude?, onPick })` — a tap-to-pick list (bottom-sheet style) of all
  collections, used by the **Move** action. Excludes the reel's current collection.
- `recentChips(collections, cap = 5)` — pure helper returning the bounded, ordered chip set for the
  **capture** surface: non-default collections, newest-created first, capped at `cap`.

`recentChips` is pure and headless-tested. The sheet DOM is thin and verified manually.

### 3.4 Delete flow (E)

From a non-default collection card on the home view:

1. Compute members = `listByCollection(col.id, saved.id)` filtered to `status !== 'dismissed'`.
2. **Empty** → delete immediately: `collectionsStore.remove(col.id)` → re-render.
3. **Non-empty** → a three-way choice sheet:
   - **Move N reels to Saved** → for each member `pending-store.move(member.id, saved.id)`
     (sets `synced=false`), then `collectionsStore.remove(col.id)`.
   - **Delete the N reels too** → for each member `pending-store.dismiss(member.id)`
     (status→dismissed, syncs), then `collectionsStore.remove(col.id)`.
   - **Cancel** → no-op.
4. After either action: `drainAll()` and re-render.

A pure helper `planCollectionDelete(members, savedId, choice)` returns the ordered list of
operations (`{kind:'move'|'dismiss', id, to?}[]` + `removeCollection`) so the branching is unit-
tested without DOM. `collectionsStore.remove` already hard-throws on the default (05a), so deleting
"Saved" is structurally impossible.

### 3.5 Wiring — `src/drain-all.ts` (wiring)

A tiny `drainAll(pendingStore, collectionsStore, fetchFn?)` that calls `drainSync` and
`drainCollections`, each guarded so one failing/offline never throws or blocks the other (mirrors
the existing fire-and-forget discipline). Used by:

- `sw.ts` `activate` (opportunistic, after the existing `drainSync`),
- each view on load,
- after every create / rename / delete / move / chip-tap.

`createCollectionsStore()` is invoked on every app-open path so "Saved" is guaranteed to exist
before any read (idempotent `ensureDefault`).

## 4. Capture-chip surface (B)

### 4.1 SW redirect carries the record id — `src/sw.ts`

`handleShare` currently redirects to `/captured.html?status=<status>`. Change: when
`result.record` exists (every status except `error`), append `&id=<record.id>`:

```ts
const id = result.record?.id;
return Response.redirect(`/captured.html?status=${status}${id ? `&id=${id}` : ""}`, 303);
```

`captured.html` is cached with `ignoreSearch`, so the query-bearing URL still matches offline.

### 4.2 `captured.html` + `src/captured-view.ts`

- The page keeps its **inline, import-free toast** ("Saved ✓" etc.) as the zero-JS / offline-before-
  bundle baseline. The auto-return timer is **extended to ~4000ms** (from 1500ms) so a user has time
  to glance and tap a chip; `error` keeps its longer timeout. Any user interaction (chip tap or tap-
  to-dismiss) cancels the pending auto-return.
- A `<script type="module" src="/src/captured-view.ts">` progressively enhances: it reads `id` +
  `status` from the query string, and if `id` is present and `status !== 'error'`:
  - `createCollectionsStore()` + `createPendingStore()`,
  - render up to 5 chips via `recentChips(collections)`,
  - render a small **"+ New in app"** link → `index.html` (deep-link to the home; no inline create),
  - on chip tap: `pending-store.move(id, colId)` → flip the toast to "Moved to <name> ✓" →
    `drainAll()` (fire-and-forget) → return to Instagram (`history.back()` best-effort) after a short
    beat.
- If `id` is absent (e.g. `error`, or an old SW that didn't pass it) the module renders nothing and
  the inline toast behaves exactly as today. **No regression for the un-enhanced path.**

### 4.3 Why zero-tap is provably preserved

The reel is persisted to "Saved" by `handleCapture` *inside the SW*, before the redirect even
issues. Doing nothing → auto-return → reel is in "Saved". The chips never gate, delay, or condition
the save; they only issue a follow-up `move`. This is asserted structurally (the save path in
`sw.ts`/`capture.ts` is unchanged) and by the existing capture tests, which stay green.

## 5. Files touched (05b)

| File | Change |
|---|---|
| `index.html` | becomes the collections home (header + mount point) |
| `src/collections-home.ts` | **new** — home render: list, counts, create/rename/delete |
| `collection.html` | **new** — detail page shell |
| `src/collection-view.ts` | **new** — detail render + per-reel Move |
| `src/collection-picker.ts` | **new** — shared picker sheet + `recentChips` pure helper |
| `src/collection-delete.ts` | **new** — `planCollectionDelete` pure helper |
| `src/drain-all.ts` | **new** — `drainAll` (drainSync + drainCollections, guarded) |
| `src/captured-view.ts` | **new** — capture-chip progressive enhancement |
| `captured.html` | add module script tag; extend auto-return to ~4s; keep inline toast |
| `src/sw.ts` | `handleShare` redirect carries `&id=`; add `captured-view` bundle + new pages to SHELL; `activate` calls `drainAll` |
| `src/reel-card.ts` (optional) | **new** — factor the shared card layout used by detail (+ reused later) |

No changes to 05a's stores or worker. `tag.html` / `tag-view.ts` untouched (→ 05c).

## 6. Tests (TDD, headless-first)

Logic lives in pure helpers so the suite stays jsdom-light (mirrors how `capture` / `reconcile-pull`
are tested). DOM-heavy behaviour is covered by `docs/manual-verification.md`.

1. `recentChips`: excludes default, newest-created first, caps at 5; empty list → no chips.
2. `planCollectionDelete`: **move** branch (every member → Saved, then remove), **dismiss** branch
   (every member dismissed, then remove), **empty** (just remove), **cancel** (no ops).
3. `drainAll`: calls both drains; one throwing/offline does not prevent the other or propagate.
4. Capture id-plumbing: a small unit over the redirect-URL builder (status+id → correct query;
   `error`/no-record → no `id`).
5. Regression: existing `capture` + `sw` capture tests stay green (zero-tap save path unchanged).
6. `npx tsc --noEmit` clean; `npx vitest run` green; `npx vite build` succeeds.

## 7. Acceptance (PRD 05 §10 items satisfied by 05b)

- [ ] A user can create and name collections; "Saved" always exists and can't be deleted.
- [ ] The app's primary view is collections; opening one lists its reels (caption/author/badge/link).
- [ ] Sharing a reel with no choice commits it to "Saved" with zero extra taps and returns to IG.
- [ ] Sharing and tapping one collection chip commits it to that collection in one tap.
- [ ] The durable save happens before/independent of the collection choice; capture still works
      offline.
- [ ] An item can be moved between collections; the change syncs (via 05a's device-owned rail).
- [ ] Deleting a collection never silently drops reels (prompt: Saved / delete / cancel).
- [ ] `collection_id` + collections list sync to D1 as device-owned; reminder columns untouched.
- [ ] Existing `topic_tags` preserved; no mandatory tagging prompt remains (tag queue is no longer
      linked from the home as a required step).

**Deferred (→ 05c):** optional cleanup view over "Saved"; backlog-promote collection picker.

## 8. Out of scope for 05b

Cleanup view (C); backlog-promote picker (D); inline collection-create on the capture hot path;
last-used chip ordering; runtime caching of JS bundles for fully-offline chips (possible later SW
enhancement, noted); any reminder-cadence coupling to collections.
