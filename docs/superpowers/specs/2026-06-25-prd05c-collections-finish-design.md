# PRD 05c — Collections: cleanup view + backlog picker (design)

**Project:** InSave
**Parent PRD:** `PRD's/05-collections.md`
**Siblings (prior):** 05a (data + sync, complete), 05b (collections UI core, complete)
**Status:** Approved design, pre-plan
**Date:** 2026-06-25

---

## 0. Scope

05c finishes PRD 05 by building the two acceptance items deferred during 05b scoping:

- **C — Cleanup view over "Saved":** the demoted tag queue (PRD §3) becomes an optional view that
  lists the unsorted "Saved" pile and lets the user move each reel into a collection. Reuses PRD 03's
  chip/move gesture, now over collections instead of tags.
- **D — Backlog-promote collection picker:** promoting an imported backlog reel (PRD 02) can target a
  collection via the same picker, defaulting to "Saved" when no choice is made.

Both are built entirely on existing pieces from 05a/05b: `reel-card.ts`, `collection-picker.ts`
(`recentChips` + `pickerSheet`), `pending-store.move`/`dismiss`/`restore`/`listByCollection`,
`collections-store`, and `drainAll`. No new data model, no schema change, no new dependencies.

After 05c, every PRD 05 §10 acceptance checkbox is satisfied.

## 1. Decisions carried in from brainstorming (2026-06-25)

- **Cleanup gesture = collection chips per card** (mirrors PRD 03's retired tag-chip gesture): a row of
  existing-collection chips (`recentChips`, ≤5) + a "More…" full picker + Dismiss. One tap to move.
- **Rename, don't keep:** `tag.html` → `cleanup.html`, `src/tag-view.ts` → `src/cleanup-view.ts`. The
  tag-queue UI is fully retired (PRD §3 demotes tagging out of the primary flow); the old "Tag your
  queue" surface is replaced, not kept alongside. A "Tidy Saved" link is added to the home (optional,
  never forced).
- **"Keep" stays default-to-Saved.** The collection picker is the optional one-tap upgrade on the
  triage surface (PRD §6.5: "default 'Saved' if none chosen"). The existing zero-extra-tap promote
  path is unchanged.
- **Cleanup undo re-homes to "Saved"** (`move(id, saved.id)`). Null-is-Saved makes an explicit-Saved
  id equivalent to the original null, so the item stays in the cleanup list after undo.

## 2. Invariants honoured (from 05a/05b)

- **`collection_id` null/undefined ≡ "Saved".** The cleanup view lists `listByCollection(saved.id,
  saved.id)` (includes null-collection items). A promoted backlog reel with no collection choice has no
  `collection_id` and is therefore in "Saved" — no extra write.
- **Device-owned content only.** `move`/`dismiss` set `synced=false` and ride `/api/sync`; reminder
  columns are never touched.
- **Views exclude `status === "dismissed"`** in the view layer; 05a/05b store methods are not changed.
- **Zero-tap/least-tap preserved.** The existing one-tap "Keep" (→ Saved) and "Keep all" (→ Saved) are
  untouched; the picker is strictly additive.

## 3. C — Cleanup view

### 3.1 Files
- Rename `tag.html` → `cleanup.html` (rewrite shell + copy).
- Rename `src/tag-view.ts` → `src/cleanup-view.ts` (rewrite content).
- `src/sw.ts`: swap `/tag.html` → `/cleanup.html` in `SHELL`; bump `CACHE` `insave-shell-v3` →
  `insave-shell-v4`.
- `vite.config.ts`: rename the `tag` input entry to `cleanup` (→ `cleanup.html`).
- `index.html`: add a "Tidy Saved" link in the header nav.

### 3.2 Behaviour (`cleanup-view.ts`)
On load: `createCollectionsStore()` (ensures "Saved") + `createPendingStore()`; resolve `saved` =
the `is_default` collection; fire-and-forget `drainAll`.

- List = `pendingStore.listByCollection(saved.id, saved.id)` filtered to `status !== "dismissed"`,
  newest-first (the store already sorts).
- Each card = `renderReelCard(item)` (shared renderer) plus a controls row:
  - **chips** = `recentChips(collections)` — each chip tap → `pendingStore.move(item.id, chip.id)`.
  - **"More…"** → opens `pickerSheet(collections, { exclude: saved.id, onPick })` for collections
    beyond the chip cap; `onPick(target)` → `pendingStore.move(item.id, target)`.
  - **Dismiss** → `pendingStore.dismiss(item.id)`.
- After a move or dismiss: the card animates out; `drainAll` fire-and-forget; show an **undo toast**
  (reuse the existing tag-view toast helper). Undo:
  - for a move → `pendingStore.move(item.id, saved.id)` (re-home to Saved) + re-append the card;
  - for a dismiss → `pendingStore.restore(item.id)` + re-append the card.
- Empty state: "Saved is tidy — nothing to sort."

Chip ordering/cap and the picker come verbatim from 05b's `collection-picker.ts`; no new logic.

## 4. D — Backlog-promote collection picker

### 4.1 `src/import/promote.ts`
Add an optional `collectionId` to the promote signature and set it on the new record when present:

```ts
export async function promote(
  item: ImportedItem,
  deps: PromoteDeps,
  collectionId?: string,
): Promise<void> {
  // ...unchanged record construction...
  const record: PendingCapture = {
    // ...existing fields...
    ...(collectionId ? { collection_id: collectionId } : {}),
  };
  // ...
}
```

Omitting `collectionId` ⇒ no `collection_id` ⇒ "Saved" (null-is-Saved). No other change to promote.

### 4.2 `src/import/triage-view.ts`
- Load collections once: `createCollectionsStore()`; resolve `saved`. Swap the local `drainSync`
  trigger for `drainAll(pendingStore, collectionsStore)`.
- `keep(item, collectionId?)` threads `collectionId` into `promote(item, deps, collectionId)`.
- Item controls: keep **"Keep"** (calls `keep(item)` → Saved). Add **"Keep to…"** → opens
  `pickerSheet(collections, { onPick: (id) => keep(item, id) })`, then marks the row kept.
- Group controls: keep **"Keep all"** (→ Saved) and **"Dismiss all"** unchanged. Add
  **"Keep all to…"** → `pickerSheet(collections, { onPick })`, then `keep(item, id)` for each item
  in the group.
- The idempotency guard in `keep` (skip already-promoted) is preserved.

The triage view's existing card/list markup is otherwise unchanged; only the action controls grow.

## 5. Files touched (05c)

| File | Change |
|---|---|
| `tag.html` → `cleanup.html` | rename + rewrite shell/copy ("Tidy your Saved pile") |
| `src/tag-view.ts` → `src/cleanup-view.ts` | rename + rewrite: Saved list + chip-move + dismiss + undo |
| `src/sw.ts` | SHELL `/tag.html`→`/cleanup.html`; CACHE v3→v4 |
| `vite.config.ts` | input entry `tag`→`cleanup` |
| `index.html` | add "Tidy Saved" nav link |
| `src/import/promote.ts` | optional `collectionId` → sets `collection_id` |
| `src/import/triage-view.ts` | "Keep to…" + "Keep all to…" via `pickerSheet`; `drainAll` |
| `tests/import/promote.test.ts` | add `collection_id` present/absent cases |

Reused unchanged: `src/reel-card.ts`, `src/collection-picker.ts`, `src/drain-all.ts`,
`src/collections-store.ts`, `src/pending-store.ts`.

## 6. Tests (headless-first)

1. `promote`: with `collectionId` → the written `PendingCapture` has `collection_id === <id>` and
   `synced === false`; without `collectionId` → `collection_id` is undefined (null-is-Saved).
2. Existing `promote`/triage/import suites stay green (the new param is optional; default behaviour
   unchanged).
3. The two DOM views (`cleanup-view`, `triage-view`) are verified by `npx tsc --noEmit` + `npx vite
   build` (build must emit `cleanup.html`) + the manual-verification checklist (§8). No jsdom (node
   test env).
4. `npx vitest run` green; `npx tsc --noEmit` clean; `npx vite build` succeeds.

## 7. Acceptance (closes PRD 05 §10)

- [ ] The tag queue is no longer a required step; an optional cleanup view over "Saved" exists and
      moves items into collections via one-tap chips.
- [ ] Backlog promotion can target a collection via the same picker; default "Saved" when no choice.
- [ ] Promoting with no choice still lands the reel in "Saved" with the existing one tap (preserved).
- [ ] Moves/dismisses from cleanup sync as device-owned content; reminder columns untouched.
- [ ] Existing `topic_tags` data is preserved; no mandatory tagging prompt remains anywhere.

With 05a + 05b + 05c, all PRD 05 §10 acceptance items are satisfied.

## 8. Manual verification (append to `docs/manual-verification.md`)

- [ ] Home shows a "Tidy Saved" link → opens the cleanup view listing unsorted "Saved" reels (incl.
      ones captured with no collection).
- [ ] Tap a collection chip on a cleanup card → the reel moves into that collection (gone from
      cleanup, present in that collection); Undo returns it to Saved.
- [ ] "More…" lists collections beyond the chip cap and moves correctly; "Saved" is not offered as a
      target.
- [ ] Dismiss on a cleanup card removes it (status=dismissed) with Undo.
- [ ] Old `/tag.html` is gone; `/cleanup.html` loads (SW cache bumped to v4; reinstall/refresh to
      clear the old shell).
- [ ] Import triage: "Keep" still promotes to "Saved" in one tap; "Keep to…" / "Keep all to…" promote
      into the chosen collection (verify `collection_id` in D1 after sync).

## 9. Out of scope for 05c

Auto-sort/AI classification (PRD §11, deferred); multi-collection per item; collection-driven reminder
cadence; the dashboard redesign. PRD 06 (importance tiers + deadlines) is the next PRD after 05c.
