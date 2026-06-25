# PRD 06: Importance Tiers + User Deadlines

**Project:** InSave
**Component:** 3-tier importance (replacing binary) + optional user-set deadlines, feeding the reminder engine
**Platform target:** Android PWA on Cloudflare (single Worker + D1 + cron), live deployment
**Status:** Draft
**Amends:** PRD 03 (importance was binary) and PRD 04 (spacing curve now keyed on 3 tiers + deadline override)

---

## 0. Why this PRD exists (user signal)

From the 20-user round: (a) binary importance ("matters" vs normal) wasn't enough granularity, users wanted a scale; (b) users wanted to set their own deadlines on items that have a real due date, rather than always relying on the automatic spacing.

The literal request was a 1–10 scale. This PRD intentionally implements **3 tiers**, not 10, for a concrete reason (see §2). It also adds an **optional deadline override**.

## 1. What changes

- **Importance:** binary (`normal` | `matters`) → **3 tiers**: **low / normal / high**. Each maps to a genuinely different spacing curve the user can actually feel.
- **Deadlines:** a user MAY optionally set an explicit deadline on an item. If set, it overrides the automatic spacing for that item's due timing. If not set, tier-based spacing drives it (unchanged model, just 3 curves instead of 2).

## 2. Why 3 tiers, not the requested 1–10

The users asked for 1–10. Implementing literally 10 levels would be **false precision**:

- People cannot meaningfully distinguish "this is a 6" from "this is a 7." In practice users cluster at the extremes and the middle (≈1, 5, 10), so a 10-point scale captures ~3 real signals while adding 10 levels of decision friction.
- The scale only matters if its levels produce **perceptibly different reminder behaviour.** Ten distinct spacing curves a user can actually feel apart is illusory; three are real (gentle / standard / aggressive).
- 3 tiers honours what's *underneath* the request ("binary isn't enough") without the friction and fake granularity of 10. Still one tap to set.

If product later wants the *feel* of a scale, the UI may present a slider, but it MUST resolve to a small number of buckets (3, or at most 5) backed by distinct curves — never 10 independent behaviours.

## 3. Importance tiers → spacing

Each tier sets the parameters of the existing spacing curve from PRD 04 (initial delay, growth factor, max cycles, max age). Indicative starting values (tuning constants, expected to change with real use — see §7):

- **high** — resurfaces soon, persists many cycles, ages out slowly. (≈ the old "matters", or a touch more aggressive.)
- **normal** — the middle/default curve.
- **low** — wide initial gap, few cycles, ages out quickly. ("Someday / nice-to-have".)

The mechanism is unchanged from PRD 04 (§3, §4): one curve, parameterised per tier. We go from 2 parameter sets to 3. Default tier for a new item is **normal**.

## 4. User deadlines (optional override)

- A user MAY set an explicit deadline (date/time) on an item.
- **If a deadline is set:** it becomes the authoritative driver of that item's due timing. The engine SHOULD ensure the item is surfaced at/appropriately before the deadline rather than following the tier's normal spacing. (E.g. the deadline sets/【caps】 `next_due_at`; the item is surfaced as the deadline approaches.)
- **If no deadline is set:** behaviour is exactly the tier-based spacing (the common case; most reels have no real due date).
- Deadlines are **optional and rare by design** — the UI must not push users to set one. It's there for the "this matters by Friday" item, not every save.
- After a deadline passes without action: define a sane behaviour (e.g. one final surfacing then age-out, or escalate once). Decide at build; default to "surface at deadline, then revert to tier spacing / age-out".

## 5. How it interacts with the engine (PRD 04)

- The cron's `selectDue` / `advance` already key off `next_due_at`, importance, and cycle state. This PRD:
  - widens importance from 2 → 3 values feeding the curve parameters;
  - adds a deadline field that, when present, overrides the computed `next_due_at` for that item.
- Idempotency, batching, quiet hours, digest, back-off-on-ignore (PRD 04) are all unchanged.
- Importance + deadline remain **device-owned content** fields (user sets them); the cron's reminder-state columns stay server-owned (the disjoint-ownership model from the deploy work holds — no reconciliation conflict).

## 6. Data model (changes)

- `importance` — values change from `normal|matters` to **`low|normal|high`**. Migration: map existing `matters` → `high`, `normal` → `normal` (and anything null → `normal`).
- `deadline_at` — new nullable timestamp on the item; null = no override.
- No change to the server-owned reminder-state columns.

D1: alter `importance` usage (text values), add `deadline_at`. Apply via `schema.sql` (fresh) / `ALTER TABLE pending_capture ADD COLUMN deadline_at INTEGER` (existing remote), per the established migration pattern.

## 7. Tuning constants (explicit non-precision)

The per-tier curve numbers (initial delays, growth factors, max cycles, max age) and the deadline pre-surfacing window are **tuning values, not settled.** Ship sane defaults; expect to adjust them after living with real reminders on a real backlog. Do not over-engineer the first numbers — the structure (3 tiers + optional deadline override) is what's fixed.

## 8. Acceptance criteria

- [ ] Importance is a 3-tier choice (low/normal/high), one tap to set, default normal.
- [ ] Each tier produces a perceptibly different resurfacing schedule (high sooner/persistent, low wide/short).
- [ ] Existing `matters` items migrate to `high`; `normal` stays `normal`; nulls default to `normal`.
- [ ] A user can optionally set a deadline on an item; most items have none.
- [ ] When a deadline is set, the item is surfaced appropriately by/before it, overriding tier spacing.
- [ ] When no deadline is set, tier-based spacing is unchanged in behaviour (aside from 3 curves vs 2).
- [ ] Importance + deadline are device-owned; setting them never disturbs server-owned reminder-state columns.
- [ ] Cron idempotency, digest batching, quiet hours, and ignore-back-off remain intact.

## 9. Open questions

- Exact per-tier curve constants and the deadline pre-surfacing window (tuning, post-real-use).
- Post-deadline behaviour (final surface then age-out vs one escalation): decide at build.
- Whether the UI presents importance as 3 labelled buttons or a 3-stop slider (both resolve to the same 3 buckets) — pick whatever tests cleaner; it's cosmetic over the same data.
- Whether `high` should be allowed to pull the *next digest* earlier (PRD 04 already allows matters to influence digest timing) — keep consistent with existing behaviour.

---

*Amends: PRD 03 (importance), PRD 04 (spacing). Pairs with: PRD 05 (collections). Precedes: dashboard redesign.*
