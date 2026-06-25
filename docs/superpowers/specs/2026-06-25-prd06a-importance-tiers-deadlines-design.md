# PRD 06a — Importance tiers + deadlines: data model + engine (design)

**Project:** InSave
**Parent PRD:** `PRD's/06-importance-tiers-and-deadlines.md`
**Sibling (next):** PRD 06b — Importance/deadline UI (3-tier control + deadline picker on reel cards)
**Amends:** PRD 03 (importance) and PRD 04 (spacing engine)
**Status:** Approved design, pre-plan
**Date:** 2026-06-25

---

## 0. Scope

PRD 06 is split (decision 2026-06-25), mirroring 05a/05b:

- **06a (this doc):** the data model change (binary importance → 3 tiers), the `matters→high`
  migration, the new optional `deadline_at` field, the 3-curve spacing engine, the deadline override
  in the cron engine, and the ranking/digest/cadence updates. **All headless / TDD-clean. No DOM.**
- **06b (next):** the user-facing 3-tier importance control and the optional deadline picker on reel
  cards (re-homing the importance setter the retired tag queue used to host), plus the `review-view`
  high-first ranking.

06a changes user-visible behaviour only indirectly: existing `matters` items become `high` (same
curve), a new `low` tier exists in the data, and the engine honours a `deadline_at` if one is present
— but nothing sets a deadline until 06b.

## 1. Decisions carried in from brainstorming (2026-06-25)

- **3 tiers, not 1–10** (PRD §2): `Importance = "low" | "normal" | "high"`, default `normal`.
- **Deadline rule** (user-confirmed): a `deadline_at` in the **future** suspends tier spacing and
  keeps the item **quiet until the deadline** (`next_due_at` driven to the deadline). At the deadline
  it surfaces; the user acts. **Snooze** resumes tier spacing — and since `snooze()` already
  reschedules off the tier curve (`now + tier.initialDelay`), no change is needed there: once the
  deadline is in the past the override is inert and tier spacing drives everything automatically.
- **Ownership (PRD §5/§6):** `importance` and `deadline_at` are **device-owned content**; the cron's
  reminder-state columns (`reminder_status`, `next_due_at`, `cycle_count`, `ignored_count`,
  `last_surfaced_at`) stay **server-owned**. The device writes only `deadline_at`; the override logic
  lives entirely in the cron engine, which reads the device-owned `deadline_at` and computes the
  server-owned `next_due_at`. No reconciliation conflict.
- **Tuning constants are not settled** (PRD §7): ship sane per-tier defaults; structure is what's
  fixed, not the numbers.

## 2. Data model

### 2.1 Types (`src/types.ts`)

```ts
export type Importance = "low" | "normal" | "high";   // was "normal" | "matters"
```

`PendingCapture` gains one field:

```ts
  deadline_at?: number;   // epoch ms; null/undefined ≡ no deadline (device-owned content)
```

### 2.2 `normalizeImportance` (`src/reminder/spacing.ts` or a small shared module)

```ts
export function normalizeImportance(raw: unknown): Importance {
  if (raw === "low" || raw === "normal" || raw === "high") return raw;
  if (raw === "matters") return "high";   // legacy PRD 03 value
  return "normal";                         // null / undefined / unknown
}
```

The single read-time coercion that makes correctness independent of what's stored: any legacy
`"matters"` (held locally or pulled from D1) resolves to `high`; anything unrecognised resolves to
`normal`. Used by `presetFor`, the digest/review ranking, the cron cadence check, and `row-to-pending`.

### 2.3 Migration

- **Local (IndexedDB):** on `createPendingStore` open, a one-time best-effort cursor rewrite of any
  record with `importance === "matters"` → `"high"` (set `synced=false` so the corrected value
  syncs). Mirrors the existing `user_id` first-mint backfill pattern in `pending-store.ts`. Guarded so
  it runs once (e.g. behind a meta flag or only when such records exist).
- **Remote (D1):** documented in `docs/manual-verification.md` per the established pattern —
  `ALTER TABLE pending_capture ADD COLUMN deadline_at INTEGER;` and a one-time
  `UPDATE pending_capture SET importance='high' WHERE importance='matters';`. Existing rows otherwise
  untouched; `deadline_at` defaults null.
- **No backfill for `deadline_at`** (null ≡ no deadline). No new index (the cron already scans by
  `user_id`/`reminder_status`/`next_due_at`; deadline is read per-item).

### 2.4 Store setters (`src/pending-store.ts`)

Replace the now-dead `tag()` importance path with explicit device-owned setters:

```ts
  setImportance(id: string, importance: Importance): Promise<void>;   // synced=false
  setDeadline(id: string, deadline_at: number | null): Promise<void>; // synced=false; null clears
```

Both reuse the existing private `patch(id, fields)` (sets `synced=false`, preserves `user_id`). The
device never writes `next_due_at` (server-owned). The legacy `tag()` method may remain for now (it has
no callers post-05c) or be reduced to topic_tags-only; its `importance` parameter type updates to the
new union. (06b removes/retypes any remaining importance-via-tag usage — there is none today.)

## 3. Spacing engine (`src/reminder/spacing.ts`)

### 3.1 Three presets (tuning values, PRD §7)

```ts
export const PRESETS: Record<Importance, Preset> = {
  high:   { initialDelay: 1 * DAY, growth: 1.6, maxCycles: 8, maxAge: 90 * DAY }, // old "matters"
  normal: { initialDelay: 3 * DAY, growth: 2.0, maxCycles: 4, maxAge: 45 * DAY }, // unchanged middle
  low:    { initialDelay: 7 * DAY, growth: 2.5, maxCycles: 2, maxAge: 21 * DAY }, // wide, short-lived
};

export function presetFor(importance: unknown): Preset {
  return PRESETS[normalizeImportance(importance)];
}
```

`high` reuses the old `matters` curve so migrated items behave identically. `low` is gentle.

### 3.2 Deadline override helper

```ts
export function effectiveNextDue(tierNextDue: number, deadline_at: number | undefined, now: number): number {
  return deadline_at != null && deadline_at > now ? deadline_at : tierNextDue;
}
```

### 3.3 `initialState` and `advance`

- `initialState(importance, now, deadline_at?)`:
  `next_due_at = effectiveNextDue(now + presetFor(importance).initialDelay, deadline_at, now)`.
- `advance(item, now)`: compute the tier interval exactly as today, then
  `next_due_at = effectiveNextDue(now + interval, item.deadline_at, now)`. **Expiry override:** if a
  deadline is in the future (`deadline_at > now`), force `reminder_status = "active"` and do not
  expire (the item must still surface at its deadline even past tier `maxCycles`/`maxAge`). Once the
  deadline is in the past, expiry is the unchanged tier rule.

This makes a future-deadline item quiet until the deadline, surface at the deadline, then — because
the override is inert once the deadline passes — follow tier spacing (and snooze, which already uses
the tier curve, resumes it).

## 4. Cron + digest + ranking

### 4.1 `worker/cron.ts`

- Lazy init passes the deadline: `initialState(it.importance, now, it.deadline_at)`.
- Cadence: `const hasMatters = …` → `const hasHigh = due.some((d) => normalizeImportance(d.importance) === "high");`
  feeding `cadenceGate(settings, now, hasHigh)` (high pulls the digest forward, as `matters` did).

### 4.2 `src/reminder/digest.ts`

- `selectDue` gates due-ness on the deadline-aware next-due so a freshly device-set deadline keeps the
  item quiet even if its stored `next_due_at` is earlier:
  an item is due when `effectiveNextDue(item.next_due_at, item.deadline_at, now) <= now`
  (plus the existing `reminder_status === "active"` condition).
- Rank: replace the binary `importance === "matters" ? 0 : 1` with a 3-tier order over the normalized
  importance — `high → 0, normal → 1, low → 2` (high first, low last).

### 4.3 Sync rail (`worker/index.ts`)

- `WireRecord` gains `deadline_at?: number`; `UPSERT_SQL` appends `deadline_at` to the INSERT column
  list, the `VALUES` placeholders, and the `ON CONFLICT(id) DO UPDATE SET` clause (device-owned
  content, newer-local-write-wins — same treatment as `collection_id`); `toBind` appends
  `r.deadline_at ?? null` as the final element (so existing bind indices don't shift). `importance`
  already rides this rail.

### 4.4 Pull-safety (`src/reminder/row-to-pending.ts`, `reconcile-pull`)

- `row-to-pending` maps `deadline_at` (`num(row.deadline_at)`) and runs `importance` through
  `normalizeImportance` (so a pulled `matters` row becomes `high`).
- `mergePulled` already keeps device-owned content on pull → `deadline_at` and `importance` are
  preserved across a server pull. Add a regression test (mirrors the `collection_id` one).

## 5. Files touched (06a)

| File | Change |
|---|---|
| `src/types.ts` | `Importance` → `low\|normal\|high`; add `deadline_at?` to `PendingCapture` |
| `src/reminder/spacing.ts` | `normalizeImportance`; 3 `PRESETS`; `presetFor` via normalize; `effectiveNextDue`; `initialState`/`advance` deadline override |
| `src/reminder/digest.ts` | `selectDue` deadline-aware gate; 3-tier rank |
| `src/reminder/row-to-pending.ts` | map `deadline_at`; normalize `importance` |
| `src/pending-store.ts` | `setImportance`, `setDeadline`; retype `tag()` importance param; local matters→high migration on open |
| `worker/cron.ts` | pass `deadline_at` to `initialState`; `hasHigh` cadence |
| `worker/index.ts` | `WireRecord`/`UPSERT_SQL`/`toBind` gain `deadline_at` |
| `schema.sql` | `deadline_at INTEGER` on `pending_capture` |
| `docs/manual-verification.md` | remote `ALTER` + `matters→high` `UPDATE` migration steps |

No change to the server-owned reminder-state columns. No new dependency.

## 6. Tests (TDD, all headless)

1. `normalizeImportance`: `matters→high`, `null/undefined/unknown→normal`, `low/normal/high` passthrough.
2. `spacing`: 3 `PRESETS` present; `presetFor("matters")` returns the `high` preset; default `normal`.
3. `effectiveNextDue`: future deadline → deadline; past/absent deadline → tier next-due.
4. `initialState`: future deadline → `next_due_at == deadline`; no deadline → `now + tier.initialDelay`.
5. `advance`: future deadline → `next_due_at == deadline` and `reminder_status == "active"` even past
   `maxCycles`; past deadline → tier interval; no deadline → unchanged from PRD 04.
6. `digest.selectDue`: an item with a future `deadline_at` but an earlier stale `next_due_at` is NOT
   selected before the deadline; selected at/after it.
7. `digest` rank: `high` before `normal` before `low`.
8. `cron`: `hasHigh` pulls the digest forward; a future-deadline item is not surfaced before its
   deadline and is at/after it.
9. `pending-store`: `setImportance`/`setDeadline` set the field with `synced=false`; the open-time
   `matters→high` migration rewrites a legacy record (and sets `synced=false`).
10. `worker-sync`: `toBind` carries `deadline_at`; `UPSERT_SQL` includes `deadline_at = excluded.deadline_at`.
11. `row-to-pending`: maps `deadline_at`; a `matters` row normalizes to `high`.
12. `reconcile-pull`: `mergePulled` preserves a local `deadline_at` and `importance` across a pull.

## 7. Acceptance (PRD §8 items satisfiable headlessly in 06a)

- [ ] Importance is a 3-tier value (low/normal/high), default normal (the one-tap UI is 06b).
- [ ] Each tier produces a perceptibly different schedule (distinct curves; high sooner/persistent,
      low wide/short).
- [ ] Existing `matters` migrates to `high`; `normal` stays `normal`; nulls default to `normal`
      (read-time normalize + local rewrite + documented remote `UPDATE`).
- [ ] A `deadline_at` field exists and, when set in the future, the engine surfaces the item by/at it,
      overriding tier spacing; absent → tier spacing unchanged.
- [ ] Post-deadline/snooze reverts to tier spacing.
- [ ] `importance` + `deadline_at` are device-owned; setting them never disturbs server-owned
      reminder-state columns (sync rail + `mergePulled` regression).
- [ ] Cron idempotency, digest batching, quiet hours, and ignore back-off remain intact (unchanged
      paths; covered by existing cron tests staying green).

(UI-dependent ACs — the 3-tier control, the optional deadline picker, review-view high-first ordering
— are 06b.)

## 8. Out of scope for 06a (→ 06b)

The importance control (3 buttons or a 3-stop slider — cosmetic, same data) and the optional deadline
picker on reel cards; the `review-view` high-first rank; any "set a deadline" entry point. Final
tuning of the per-tier constants and the post-deadline escalation policy beyond "surface at deadline,
then tier spacing" (PRD §7/§9) stay deferred — sane defaults ship here.
