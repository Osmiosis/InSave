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
- **Polish: minimal.** Integrate the controls cleanly into the existing dark card layout; the
  deadline's set-state (`[date] [×]`) in the control block is the badge. No status/next-due hints, no
  broader restyle.
- **Date resolution: local start-of-day.** A picked date `YYYY-MM-DD` resolves to that day's
  `00:00` **local** epoch ms. So "Jul 3" drives the item due at the start of Jul 3 and it surfaces in
  Jul 3's digest (quiet-hours/digest cadence gate the actual notification time). Clearing sends
  `null`.

## 2. Card structure

`renderCard` inserts a labelled controls block between the link and the existing Done/Snooze row.
Layout when a deadline is set:

```
@author  [reel]
caption…
Open in Instagram ↗
── importance ──
[ low ][ normal ][ high ]           ← segmented; current tier has .active
+ Set deadline   /   [ Jul 3 ] [×]  ← single source of truth; re-renders on change
[ Done ] [ Snooze ]
```

The deadline's set-state (`[date] [×]`) **is** the badge — there is no separate `.meta` badge, so it
can never go stale when the user clears the deadline (the control re-renders in place).

### 2.1 Importance row
- Three `<button>`s, labels `low` / `normal` / `high`.
- Current tier = `normalizeImportance(item.importance)` gets an `.active` class (legacy `matters` →
  `high`, null/unknown → `normal`).
- Tap a tier → `store.setImportance(item.id, tier)`, repaint `.active` (new tier on, others off),
  then fire-and-forget `drainSync(store)`. **No re-sort or card removal** — the user stays mid-review;
  the new ordering applies on the next visit.

### 2.2 Deadline control
- Default (no `deadline_at`): a `+ Set deadline` link/button. Tap → reveal `<input type="date">`.
- On a valid date pick: `dateInputToEpoch(input.value)` → local start-of-day epoch (§4) →
  `store.setDeadline(item.id, epoch)` → re-render the control to the `[date] [×]` set-state →
  `drainSync(store)`.
- `×` → `store.setDeadline(item.id, null)` → re-render to `+ Set deadline` → `drainSync(store)`.
- Empty/invalid input (`dateInputToEpoch` returns `null`) → no-op (don't call the setter).
- On render, if `item.deadline_at` is already set, start in the `[date] [×]` set-state, not the
  `+ Set deadline` link.

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

## 4. Testability split (matches the repo's headless convention)

This repo has **no jsdom** and **no DOM tests** — every view (`review-view`, `reel-card`,
`captured-view`, `collection-view`) is untested by convention; only headless logic is tested
(`environment: "node"`, tests under `tests/`). `review-view.ts` even calls `document.getElementById`
at module load, so it cannot be imported in a node test at all. 06b follows the same discipline: pull
the one piece of *real* logic into a pure, headless-tested helper; leave the DOM glue untested like
every sibling view.

- **`src/deadline-input.ts` (new, pure, tested):**
  `export function dateInputToEpoch(value: string): number | null` — converts a native
  `<input type="date">` value `"YYYY-MM-DD"` to a **local start-of-day** epoch ms
  (`new Date(y, m-1, d).getTime()`); returns `null` for empty or malformed input. This is the only new
  unit-tested function in 06b.
- **Already-tested logic 06b reuses (no new tests):** `normalizeImportance` (06a — drives the active
  tier), `setImportance`/`setDeadline` (pending-store.test.ts), `drainSync` (sync.test.ts).
- **DOM glue (untested, per convention):** `importanceRow(item, store)` and
  `deadlineControl(item, store)` local helpers in `review-view.ts` (keep `renderCard` readable), plus
  the in-control set-state badge. `renderCard(item, userId)` → `renderCard(item, userId, store)` so the
  control helpers can reach the setters (today `store` is a local in `main()`). No change to
  `reel-card.ts`. The set-state badge label is formatted inline
  (`new Date(epoch).toLocaleDateString(...)`) — cosmetic, untested.

## 5. Error handling

- Setter rejects (IndexedDB) → leave prior UI state, no throw (wrap in try/catch like `postAction`).
- `drainSync` failure → silent, retries next trigger (already its contract).
- Invalid/empty date → no-op.

## 6. Files touched (06b)

| File | Change |
|---|---|
| `src/deadline-input.ts` (new) | pure `dateInputToEpoch(value)` helper |
| `tests/deadline-input.test.ts` (new) | headless tests in §7 |
| `src/review-view.ts` | `importanceRow`/`deadlineControl` helpers; thread `store` into `renderCard`; `dateInputToEpoch` + `setDeadline`; `setImportance`; `drainSync` after setters; in-control set-state badge |
| `review.html` | CSS for the segmented importance buttons (`.tier`, `.tier.active`) and the deadline link/set-state (`.deadline-add`, `.deadline-set`, `.deadline-clear`) |

No data-layer/engine/worker/schema/dependency changes.

## 7. Tests (TDD, headless — `tests/deadline-input.test.ts`, `environment: node`)

Only `dateInputToEpoch` is new logic; the rest is already covered or is untested DOM glue (see §4).

1. `dateInputToEpoch("2026-07-03")` → `new Date(2026, 6, 3).getTime()` (local start-of-day).
2. `dateInputToEpoch("")` → `null`.
3. `dateInputToEpoch("not-a-date")` → `null` (malformed).

**Already green, relied on (no new tests):** `normalizeImportance` (06a) drives the active tier;
`setImportance`/`setDeadline` (pending-store.test.ts) and `drainSync` (sync.test.ts) cover the
write+push path. DOM rendering (buttons, badge, listeners) is untested, consistent with all sibling
views.

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
