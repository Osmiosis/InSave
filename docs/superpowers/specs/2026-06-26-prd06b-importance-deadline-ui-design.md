# PRD 06b — Importance/deadline UI (design)

**Project:** InSave
**Parent PRD:** `PRD's/06-importance-tiers-and-deadlines.md`
**Sibling (prev):** PRD 06a — importance tiers + deadlines: data model + engine (data/engine, headless)
**Amends:** PRD 03 (the importance setter the retired tag queue hosted)
**Status:** Approved design, pre-plan
**Date:** 2026-06-26

---

## 0. Scope

PRD 06 is split (06a data/engine, 06b UI). 06a shipped the whole data layer: 3-tier
`Importance` (`low|normal|high`), `deadline_at`, `normalizeImportance`, the 3-curve spacing engine,
the deadline override, `pending-store.setImportance`/`setDeadline`, the sync rail, and the
`review-view` high-first ranking (already live). **06b is pure UI** — it gives the user a way to set
those device-owned fields.

This doc covers only `review.html` / `src/review-view.ts`. **No data-layer, engine, worker, or
schema changes. No new dependencies.** Everything 06b calls already exists.

## 1. Decisions carried in from brainstorming (2026-06-26)

- **Home: the review-view card.** The 3-tier importance control + optional deadline picker live on
  each reminder card in `review.html`, alongside Done/Snooze. This closes the reminder loop: InSave
  keeps surfacing an item → the user bumps it to `high` or sets a deadline right there. Importance
  defaults `normal` until then (the engine already seeds `normal` at lazy-init). The shared
  `reel-card.ts`, `captured-view`, and `collection-view` are **not** touched.
- **Importance form: segmented buttons.** Three tap targets `low | normal | high`; the current tier
  is highlighted, one tap changes it. Clear current-state read, accessible, trivial to test. (PRD §9
  left this open as cosmetic; buttons test cleaner than a slider.)
- **Deadline UX: collapsed, date-only.** A quiet `+ Set deadline` link reveals a native
  `<input type="date">`. Once set, the card shows the date as a badge with a clear `×`. Date-only —
  enough for "by Friday", keeps it rare and non-pushy per PRD §4/§7 ("the UI must not push users to
  set one").
- **Polish: minimal.** Integrate the controls cleanly into the existing dark card layout; show the
  deadline as a badge in `.meta` when set. No status/next-due hints, no broader restyle.
- **Date resolution: local start-of-day.** A picked date `YYYY-MM-DD` resolves to that day's
  `00:00` **local** epoch ms. So "Jul 3" drives the item due at the start of Jul 3 and it surfaces in
  Jul 3's digest (quiet-hours/digest cadence gate the actual notification time). Clearing sends
  `null`.

## 2. Card structure

`renderCard` inserts a labelled controls block between the link and the existing Done/Snooze row.
Layout when a deadline is set:

```
@author  [reel]  [⏳ Jul 3]        ← deadline badge in .meta, only when deadline_at set
caption…
Open in Instagram ↗
── importance ──
[ low ][ normal ][ high ]           ← segmented; current tier has .active
+ Set deadline   /   [ 2026-07-03 ] [×]
[ Done ] [ Snooze ]
```

### 2.1 Importance row
- Three `<button>`s, labels `low` / `normal` / `high`.
- Current tier = `normalizeImportance(item.importance)` gets an `.active` class (legacy `matters` →
  `high`, null/unknown → `normal`).
- Tap a tier → `store.setImportance(item.id, tier)`, repaint `.active` (new tier on, others off),
  then fire-and-forget `drainSync(store)`. **No re-sort or card removal** — the user stays mid-review;
  the new ordering applies on the next visit.

### 2.2 Deadline control
- Default (no `deadline_at`): a `+ Set deadline` link/button. Tap → reveal `<input type="date">`.
- On a valid date pick: resolve to local start-of-day epoch (`new Date(y, m-1, d).getTime()` from the
  input's `YYYY-MM-DD`, or `valueAsNumber` + local-offset correction — implementer's choice, must be
  local midnight) → `store.setDeadline(item.id, epoch)` → swap to the `[date] [×]` set-state + add the
  `.meta` badge → `drainSync(store)`.
- `×` → `store.setDeadline(item.id, null)` → revert to `+ Set deadline`, remove the badge →
  `drainSync(store)`.
- Empty/invalid input → no-op (don't call the setter).
- On render, if `item.deadline_at` is already set, start in the set-state (badge + `[date] [×]`),
  not the `+ Set deadline` link.

## 3. Data flow

```
setImportance / setDeadline   (synced=false, device-owned, never writes next_due_at)
        │
        └─ drainSync(store)  →  POST /api/sync  →  D1 UPSERT (importance, deadline_at)
                                        │
                                        └─ cron reads importance + deadline_at,
                                           recomputes server-owned next_due_at
                                           (06a deadline override / tier curve)
```

`drainSync` is fire-and-forget (its existing contract): offline/transient failure just retries on the
next drain trigger, exactly like the card's `postAction`. The device never writes `next_due_at`, so
there is no reconciliation conflict (06a ownership invariant holds). `review-view` currently does not
push device-owned writes; 06b adds the `drainSync(store)` call after each setter — `drainSync` needs
only the pending store (`listUnsynced`/`markSynced`), so no collections plumbing.

## 4. Refactor (in `src/review-view.ts`)

`renderCard` is already ~70 lines and grows with two control blocks. Extract small local helpers in
the same file so each unit is independently testable and `renderCard` stays readable:

- `importanceRow(item, store): HTMLElement`
- `deadlineControl(item, store): HTMLElement`

Both take the **store** so they can call the setters. `renderCard(item, userId)` →
`renderCard(item, userId, store)`: today it closes over the module-level `store` from `main()`; thread
it as a parameter so tests can pass a fake store and production passes the real one built in `main()`.
No change to `reel-card.ts`.

## 5. Error handling

- Setter rejects (IndexedDB) → leave prior UI state, no throw (wrap in try/catch like `postAction`).
- `drainSync` failure → silent, retries next trigger (already its contract).
- Invalid/empty date → no-op.

## 6. Files touched (06b)

| File | Change |
|---|---|
| `src/review-view.ts` | `importanceRow`/`deadlineControl` helpers; thread `store` into `renderCard`; `drainSync` after setters; deadline badge in `.meta` |
| `review.html` | CSS for the segmented importance buttons (`.tier`, `.tier.active`), the deadline link/badge, and the `.meta` deadline badge |
| `src/review-view.test.ts` (new or extended) | tests in §7 |

No data-layer/engine/worker/schema/dependency changes.

## 7. Tests (TDD, jsdom — matches existing `*.test.ts`)

1. Renders three importance buttons; the item's current tier has `.active`.
2. Tap `high` → `setImportance(id,"high")` called; `high` becomes `.active`, others lose it.
3. Legacy `matters` item renders with `high` active (via `normalizeImportance`).
4. `+ Set deadline` hidden state → reveals the date input on tap.
5. Pick a date → `setDeadline(id, <local start-of-day epoch>)`; badge + `×` shown.
6. Item with an existing `deadline_at` renders in the set-state (not the `+ Set deadline` link).
7. `×` → `setDeadline(id, null)`; reverts to `+ Set deadline`, badge removed.
8. Each setter triggers a `drainSync` (spy via injected fetch / fake store).
9. Existing high-first sort + Done/Snooze behaviour stays green.

## 8. Acceptance (the UI-dependent ACs PRD 06a deferred)

- [ ] Importance is a 3-tier choice (low/normal/high), one tap to set, default normal — on the review
      card.
- [ ] Setting a tier calls `setImportance` (device-owned, `synced=false`) and pushes via `drainSync`;
      never writes `next_due_at`.
- [ ] A user can optionally set a deadline on an item; the affordance is collapsed and does not push
      (most items show only `+ Set deadline`).
- [ ] Setting a deadline calls `setDeadline` with a local start-of-day epoch and pushes; clearing
      sends `null`.
- [ ] Legacy `matters` items display as `high`.
- [ ] `review-view` high-first ordering (already shipped in 06a) is unchanged.

## 9. Out of scope

Shared `reel-card.ts`, `captured-view`, `collection-view`; per-card status/next-due hints; broader
visual restyle; date+time precision; the pre-deadline pre-surfacing window (06a defers it). Final
per-tier tuning constants stay deferred (06a/PRD §7).
