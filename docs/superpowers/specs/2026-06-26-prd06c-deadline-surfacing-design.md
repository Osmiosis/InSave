# PRD 06c — Deadline surfacing reliability (design)

**Project:** InSave
**Parent PRD:** `PRD's/06-importance-tiers-and-deadlines.md`
**Amends:** PRD 06a (the `effectiveNextDue` deadline override + cron gating)
**Status:** Approved design, pre-plan
**Date:** 2026-06-26

---

## 0. Why this exists

Live testing (2026-06-26) showed a deadline set through the 06b UI **never surfaced the item**. Root
cause is in the 06a engine, not just cadence/quiet-hours gating:

- `effectiveNextDue(tierNextDue, deadline_at, now) = deadline_at > now ? deadline_at : tierNextDue`.
- `selectDue` gates due-ness on `effectiveNextDue(next_due_at, deadline_at, now) <= now`.
- When a deadline is set via 06b on an **already-scheduled** item (its server-owned `next_due_at` is
  days out — the common 06b case), nothing pulls `next_due_at` to the deadline. So:
  - while `deadline_at > now`: effective = deadline (future) → not due (quiet) ✓
  - once `deadline_at <= now`: effective = the stale `next_due_at` (still days out) → **still not due** ✗

The deadline only ever implemented the "quiet until" half, never the "surface at" half. It is also
compounded by the cadence gate (a high item needs a 24h digest gap) and quiet hours (22–08), but the
**primary** defect is that the item never becomes due. Additionally, the 06b date picker resolves a
date to **local midnight**, so "today" is usually **already in the past** by afternoon — and the old
code ignored a past deadline entirely.

## 1. Decisions carried in from brainstorming (2026-06-26)

- **"Surface by then — sooner is fine."** A deadline is an *additional* "fire by this time" guarantee;
  it must **not** delay the item's normal gentle schedule and must **not** keep it quiet before the
  deadline. (Removes 06a's "quiet until deadline" suppression.)
- **Bypass the cadence gate.** A deadline-driven surfacing ignores the digest-frequency minimum — that
  is the point of a deadline.
- **Respect quiet hours.** A deadline that lands during quiet hours (22–08) does **not** wake the user;
  it surfaces at the first non-quiet cron tick (e.g. an 02:00 deadline fires at 08:00). Quiet hours are
  sleep protection; cadence is mere frequency.

## 2. The model

A deadline stops touching `next_due_at` and instead adds one more way for an item to be **due**:

> An **active** item is due when
> `next_due_at <= now` (its normal tier schedule)
> **OR** it has an **unserviced reached deadline**:
> `deadline_at != null && deadline_at <= now && (last_surfaced_at ?? 0) < deadline_at`.

The deadline clause is the entire fix, and it covers three things at once:

- **Fires reliably at the deadline** — a direct `deadline_at <= now` test, no `effectiveNextDue`
  boundary to miss.
- **Fires exactly once** — when it surfaces, `advance` writes `last_surfaced_at = now`, which is
  `>= deadline_at`, so the clause flips false on the next tick. No hourly repeat. **No new column** —
  reuses the existing server-owned `last_surfaced_at`.
- **Handles past deadlines** — a deadline already in the past when set (e.g. "today" → local midnight,
  reached by afternoon) but never serviced still fires once ("already late → surface now / at
  quiet-end"). This is precisely the case that produced nothing in live testing.

## 3. Engine changes (`src/reminder/spacing.ts`)

- **Remove `effectiveNextDue`.** With "sooner is fine," a deadline no longer overrides `next_due_at`,
  so the helper (and its boundary bug) goes away.
- **`initialState(importance, now)`** — drop the `deadline_at` parameter and override; seed
  `next_due_at = now + presetFor(importance).initialDelay` (tier only). The deadline clause in
  `selectDue` handles firing by the deadline.
- **`advance(item, now)`** — `next_due_at = now + interval` (tier only; no `effectiveNextDue`). **Keep**
  the anti-expiry guard so a near-expiry item still lives to fire at a pending deadline:
  `deadlineActive = item.deadline_at != null && item.deadline_at > now` → force
  `reminder_status = "active"` (do not expire). Once the deadline is reached/serviced, normal tier
  expiry applies.

## 4. Digest changes (`src/reminder/digest.ts`)

- Add a helper:
  ```ts
  export function isDeadlineDue(item: PendingCapture, now: number): boolean {
    return item.deadline_at != null
      && item.deadline_at <= now
      && (item.last_surfaced_at ?? 0) < item.deadline_at;
  }
  ```
- **`selectDue`** — replace the `effectiveNextDue(...) <= now` filter with:
  ```ts
  i.reminder_status === "active" && ((i.next_due_at ?? Infinity) <= now || isDeadlineDue(i, now))
  ```
  The 3-tier rank (`high → normal → low`) and `DIGEST_CAP` slice are unchanged. (Drop the
  `effectiveNextDue` import.)

## 5. Cron changes (`worker/cron.ts`)

- **Lazy-init** — `initialState(it.importance, now)` (drop the `it.deadline_at` arg).
- **Cadence bypass** — after computing `due`, let a deadline-driven surfacing skip the cadence gate:
  ```ts
  const hasHigh = due.some((d) => normalizeImportance(d.importance) === "high");
  const hasDeadlineDue = due.some((d) => isDeadlineDue(d, now));
  if (!cadenceGate(settings, now, hasHigh) && !hasDeadlineDue) continue;
  ```
- **Quiet hours** — unchanged (the existing `isQuietHours` `continue` in step 2 stays). A deadline-due
  item remains due across quiet hours (its clause holds — `last_surfaced_at` stays `< deadline_at`
  until it actually surfaces) and fires at the first non-quiet tick.
- **Idempotency** — the existing `last_surfaced_at >= cycleStart` per-cycle guard and the
  `advance`-writes-`last_surfaced_at` step are unchanged; together with the deadline clause they give
  exactly-once deadline firing.

## 6. Ownership / sync

Unchanged from 06a. The cron owns `next_due_at` / `last_surfaced_at` / reminder-state; the device owns
`deadline_at`. `mergePulled` still preserves device content on pull. No schema change, no new index, no
new dependency. `deadline_at` is **not** cleared after firing (it is device-owned) — the
`last_surfaced_at >= deadline_at` check is what prevents re-firing; setting a *new* (later) deadline
naturally re-arms the clause.

## 7. Files touched (06c)

| File | Change |
|---|---|
| `src/reminder/spacing.ts` | remove `effectiveNextDue`; `initialState`/`advance` drop the `next_due` deadline override; `advance` keeps the future-deadline anti-expiry guard |
| `src/reminder/digest.ts` | add `isDeadlineDue`; `selectDue` due-clause uses it; drop `effectiveNextDue` import |
| `worker/cron.ts` | lazy-init drops the deadline arg; cadence bypass via `hasDeadlineDue` |
| tests (`spacing`, `digest`, `cron`) | update 06a deadline tests to the new semantics; add the cases in §8 |

No UI, schema, worker-sync, or dependency change.

## 8. Tests (TDD, all headless)

1. `spacing.initialState`: `next_due_at == now + tier.initialDelay` (no deadline param); a separate
   deadline no longer changes `next_due_at`.
2. `spacing.advance`: `next_due_at == now + interval` regardless of `deadline_at`; a **future** deadline
   keeps `reminder_status == "active"` even past `maxCycles`/`maxAge` (anti-expiry); a **past** deadline
   does not block normal expiry.
3. `digest.isDeadlineDue`: true when `deadline_at <= now` and `last_surfaced_at < deadline_at`; false
   when not yet reached, or already serviced (`last_surfaced_at >= deadline_at`), or no deadline.
4. `digest.selectDue`: selects an item whose `next_due_at` is in the future but whose `deadline_at` is
   in the **past** and unserviced (the live-bug case); does **not** select it once
   `last_surfaced_at >= deadline_at`; still selects a normally-due (`next_due_at <= now`) item with no
   deadline (sooner-is-fine path unaffected).
5. `cron`: a future-`next_due` item with a reached unserviced deadline is surfaced **and** bypasses the
   cadence gate (last digest < the cadence gap); it is surfaced exactly once across consecutive ticks
   (second tick: `last_surfaced_at >= deadline_at` → not re-selected).
6. `cron`: quiet hours still suppress a deadline-due item (no notify during quiet hours); it surfaces on
   the first non-quiet tick.

## 9. Acceptance

- [ ] A deadline set via the 06b UI on an already-scheduled item surfaces the item at/after the
      deadline (future deadline) or at the next eligible tick (past deadline) — the live-test failure is
      fixed.
- [ ] A deadline-driven surfacing bypasses the cadence gate.
- [ ] A deadline-driven surfacing respects quiet hours (fires at quiet-end, never during).
- [ ] A deadline fires exactly once (no hourly repeat).
- [ ] A deadline never delays normal surfacing ("sooner is fine"): an item due earlier by its tier
      schedule still surfaces then.
- [ ] Ownership intact: the device never writes `next_due_at`/`last_surfaced_at`; the cron derives them.
- [ ] Existing cron idempotency, digest batching/cap, 3-tier rank, quiet hours, and ignore back-off
      remain green.

## 10. Out of scope

The pre-deadline pre-surfacing *lead window* (PRD 06 §7 — "surface a bit before the deadline") stays
deferred; 06c fires *at/after* the deadline, gated only by quiet hours. Per-tier tuning constants are
untouched. No UI change (the 06b control already writes `deadline_at`).
