# PRD 04a — Reminder Engine Core (headless) — Design Spec

**Date:** 2026-06-24
**Project:** InSave
**Source PRD:** `PRD's/04-reminder-engine.md`
**Depends on:** PRD 01 (capture/sync), PRD 02/02b (backlog import + captions), PRD 03 (tag queue — supplies `tagged` items with `importance`, `topic_tags`, timestamps)
**Status:** Locked (implemented)

---

## 1. Purpose

Build the **headless scheduling brain** of the Reminder Engine: the server-side logic that decides
which tracked (`tagged`) reels are due, advances them along a spaced-repetition curve keyed on
importance, and assembles a capped, quiet-hours-respecting digest per user — all running on a
Cloudflare Cron Worker that reads and writes D1 on a schedule, without the device being open.

This cycle deliberately stops short of delivery. The actual Web Push send is **stubbed behind an
injected `notify(userId, digest)` seam**, so the entire engine is deterministic and unit-testable
now. Real Web Push, the review-view UI, the device-side D1 pull/reconciliation, and account-based
multi-device transfer are a separate later cycle (04b).

## 2. Scope

**In scope (04a):**
- Device-minted `user_id` identity; every record/setting scoped to it (no auth/login).
- Reminder-state data model on `pending_capture` + a new `user_settings` table (D1 + IndexedDB v4).
- Pure scheduling modules: `spacing` (the curve), `response` (state transitions), `digest`
  (due-selection + gating).
- The Cron Worker: per-user lazy-init of freshly-`tagged` items, per-cycle due selection → state
  advance → stubbed `notify`. Idempotent.
- Device stamps `user_id` on every write (reminder state stays cron-owned; `tag()` is otherwise
  unchanged).
- The Worker device-sync upsert kept disjoint from reminder-state columns, so a device re-sync never
  clobbers a cron advance.

**Out of scope (deferred to 04b):**
- Web Push (VAPID, payload encryption, subscription storage + PWA registration).
- The review-view UI + notification actions (done/snooze from the device).
- The device-side D1 **pull/read-back** path + reconciliation (reinstall restore). 04a only has the
  *Worker* reading D1 server-side; the *device* pull is 04b.
- Account-based multi-device transfer (designed-for via `user_id` scoping; UX deferred).
- Topic tags affecting scheduling (PRD §7: organizational only in v1).

## 3. Identity (settled)

- On first run the device generates an opaque `user_id` (UUID), persists it locally (IndexedDB
  meta), and stamps it on every record and settings write.
- All D1 queries the cron runs are scoped `WHERE user_id = ?`. D1 is genuinely multi-user; there is
  no auth in this cycle.
- **Designed-for-later:** account-based transfer (merge a device's `user_id` data under an account so
  multiple devices share it) is a future cycle. Nothing here blocks it — it becomes a `user_id`
  remap/merge operation.

## 4. Data model

### 4.1 `PendingCapture` (src/types.ts) — new fields
All reminder-state fields are **server-owned** (cron is the sole writer after the initial seed) and
optional (absent until `tagged`):
- `user_id?: string` — owning device/user (stamped on every write, all sources).
- `reminder_status?: "active" | "snoozed" | "done" | "expired"`
- `next_due_at?: number` — epoch ms; when it next becomes eligible to surface.
- `cycle_count?: number` — times surfaced.
- `ignored_count?: number` — consecutive surfaced-but-untouched cycles (drives back-off).
- `last_surfaced_at?: number` — epoch ms of last surfacing (idempotency guard).

### 4.2 `UserSettings` (new type + store)
Keyed by `user_id`:
- `user_id: string`
- `quiet_start: number` / `quiet_end: number` — local hour-of-day (0–23); default 22 / 8.
- `timezone: string` — IANA tz (e.g. `"Asia/Kolkata"`); device-supplied; default from the device.
- `cadence: "often" | "balanced" | "rarely"` — default `"balanced"`.
- `reminders_paused: boolean` — default `false`.
- `last_digest_at?: number` — epoch ms of the last emitted digest (cadence gate).
- `synced: boolean` — local-only.

### 4.3 D1 schema (schema.sql) + migration
- `ALTER TABLE pending_capture ADD COLUMN user_id TEXT;`
- `... ADD COLUMN reminder_status TEXT;`
- `... ADD COLUMN next_due_at INTEGER;`
- `... ADD COLUMN cycle_count INTEGER;`
- `... ADD COLUMN ignored_count INTEGER;`
- `... ADD COLUMN last_surfaced_at INTEGER;`
- New table `user_settings (user_id TEXT PRIMARY KEY, quiet_start INTEGER, quiet_end INTEGER, timezone TEXT, cadence TEXT, reminders_paused INTEGER, last_digest_at INTEGER)`.
- Index `idx_due ON pending_capture (user_id, reminder_status, next_due_at)` for the cron's hot query.
- `schema.sql` updated for fresh DBs; a documented `ALTER TABLE` set covers existing remote DBs
  (same pattern as PRD 02/03). Documented in `docs/manual-verification.md`.

### 4.4 IndexedDB (src/db.ts) → v4
- Add the reminder-state + `user_id` fields to the `pending_capture` shape (no new index needed for
  04a; the device only writes the seed). Add a `user_settings` object store (keyPath `user_id`) and
  a tiny `meta` store (keyPath `key`) to hold the device's own `user_id`. The v4 upgrade only adds
  stores; existing records are untouched.

### 4.5 Ownership / reconciliation seam (for 04b)
- **Server-owned (cron is the SOLE writer):** `reminder_status`, `next_due_at`, `cycle_count`,
  `ignored_count`, `last_surfaced_at`. The device never writes these.
- **Device-owned:** `status` (pending/tagged/dismissed), `topic_tags`, `importance`, `description`,
  `user_id`, identity columns.
- **Two disjoint write paths, no shared columns:** the device `/api/sync` upsert
  (`worker/index.ts`) writes only identity + device-owned columns; it neither inserts nor updates the
  five reminder-state columns (they default null on insert and are excluded from the
  `ON CONFLICT(id) DO UPDATE SET` clause). The cron (`worker/cron.ts`) writes ONLY the reminder-state
  columns. Because the column sets are disjoint, a device re-sync can never clobber a cron advance and
  the cron never touches user content — no last-write-wins arbitration is needed in 04a.
- Reminder state is therefore **initialized by the cron** (lazy init, §6), not seeded by the device.

## 5. The scheduling brain (pure modules — `src/reminder/`)

### 5.1 `spacing.ts`
One curve, two parameter presets keyed on importance:

| preset    | initialDelay | growth | maxCycles | maxAge  |
|-----------|--------------|--------|-----------|---------|
| `matters` | 1 day        | ×1.6   | 8         | 90 days |
| `normal`  | 3 days       | ×2.0   | 4         | 45 days |

(Constants live in one `PRESETS` object — these are tuning values per PRD §10; expect to adjust.)

- `initialState(importance, now)` → `{ reminder_status: "active", cycle_count: 0, ignored_count: 0, next_due_at: now + initialDelay }`. Used by the cron's lazy init (§6), not by the device.
- `advance(item, now)` → interval = `initialDelay × growth^cycle_count`; returns updated
  `next_due_at = now + interval`, `cycle_count + 1`, `last_surfaced_at = now`. Transitions to
  `reminder_status = "expired"` when `cycle_count + 1 > maxCycles` OR `(now - firstSeed age) > maxAge`
  (age measured from `tagged_at`/`captured_at`). Importance read from `item.importance` (default
  `normal`).
- `matters` vs `normal` produce visibly different schedules (sooner+persistent vs gentler+shorter) —
  a required acceptance criterion.

### 5.2 `response.ts` — pure state transitions
- `markDone(item)` → `reminder_status = "done"` (stops surfacing).
- `snooze(item, now)` → `next_due_at = now + initialDelay(importance)` (one base interval), stays
  `active`, **does not** change `ignored_count` (no penalty).
- `markOpened(item)` → `ignored_count = 0` (engagement), stays `active` — open ≠ done (PRD §10:
  v1 does not auto-retire on open).
- `markIgnored(item, now)` → `ignored_count + 1`; once `ignored_count >= IGNORE_THRESHOLD` (default
  **2**), accelerate decay: apply a steeper growth (`growth × IGNORE_ACCEL`, default ×1.5) and lower
  the effective age-out horizon. All back-off behavior sits behind `IGNORE_THRESHOLD`/`IGNORE_ACCEL`
  so flipping PRD §10's "ignore = back off vs. keep trying" is a config change, not a rewrite.

### 5.3 `digest.ts` — due selection + gating
- `selectDue(items, settings, now)`:
  - filter `reminder_status === "active"` AND `next_due_at <= now`;
  - if `settings.reminders_paused` → empty;
  - order by importance (`matters` before `normal`), then most-overdue (`next_due_at` ascending);
  - cap at `DIGEST_CAP` (default **5**); overflow waits for the next cycle.
- `isQuietHours(settings, now)` → true if `now`'s local hour (per `settings.timezone`) is within
  `[quiet_start, quiet_end)` treating the wrap across midnight.
- `cadenceGate(settings, now)` → false if `now - last_digest_at < minGap(cadence)`
  (`often`=1d, `balanced`=2d, `rarely`=4d). A due `matters` item in the candidate set may lower the
  effective gap to the `often` value for *this* emission (never overriding quiet hours).

## 6. The Cron Worker (`worker/cron.ts`)

- **Trigger:** Cloudflare Cron Trigger, hourly (`0 * * * *`) via `scheduled(event, env, ctx)`. Hourly
  tick ≠ hourly notifications — emission is gated below. (The existing `worker/index.ts` keeps the
  `/api/sync` fetch handler; the cron is a separate `scheduled` export, wired in `wrangler.toml`.)
- **Per run:** derive `cycleStart = floor(now to the hour)`. For each distinct `user_id` with
  `tagged` items:
  1. **Lazy init:** any `tagged` item with `reminder_status` null gets `initialState(importance,
     now)` written to D1 — this is how a freshly-tagged item (PRD 03) enters the loop. (At most one
     cron interval after tagging.)
  2. load `user_settings` (create defaults if missing);
  3. if `reminders_paused` or `isQuietHours` or `!cadenceGate` → skip (hold to next allowed window);
  4. `due = selectDue(items, settings, now)`; if empty → skip;
  5. for each surfaced item: `advance(item, now)`; only if `last_surfaced_at < cycleStart`
     (idempotency guard) — write the updated reminder-state columns back to D1;
  6. `notify(userId, due)` — **injected, stubbed in 04a** (records the would-send digest);
  7. set `user_settings.last_digest_at = now` (marks the cycle emitted).
- **Idempotency:** a retry/double-run at the same `cycleStart` re-selects the same items but
  (a) `advance` is skipped where `last_surfaced_at >= cycleStart`, and (b) `last_digest_at >=
  cycleStart` makes `cadenceGate` skip re-emission. No double-advance, no double-send.
- `notify` signature: `(userId: string, items: PendingCapture[]) => Promise<void>`. 04b swaps the stub
  for the real Web Push sender; nothing else in the cron changes.

## 7. PRD 03 integration + identity stamping

- `pending-store.tag()` is **unchanged with respect to reminder state** — it does not write reminder
  columns (those are cron-owned, §4.5). A `tagged` item is picked up and initialized by the cron's
  lazy init (§6.1) on its next run.
- `dismiss()`/`restore()` are unchanged; dismissed items are never `active` so the cron ignores them.
- **Identity:** on first run the device mints a `user_id` (UUID) into the IndexedDB `meta` store; the
  pending-store stamps `user_id` on every `put`/`tag`/`dismiss`/`restore` write (read once from
  `meta`). A one-time local backfill stamps `user_id` onto any pre-existing records lacking one and
  marks them `synced=false` so they reach D1 attributed. `drainSync`/`toWire` carry `user_id` to the
  Worker; the device upsert writes it (device-owned).

## 8. Testing strategy

Node-testable units, TDD (vitest; fake-indexeddb where IDB is involved; a fake D1 for the cron,
mirroring the existing `worker-sync` test's in-memory fake):
- **`spacing`**: `initialState` seeds correctly; `advance` widens intervals per preset; `matters` and
  `normal` diverge; age-out to `expired` past maxCycles and past maxAge.
- **`response`**: `markDone` retires; `snooze` defers one base interval without touching
  `ignored_count`; `markOpened` resets `ignored_count`; `markIgnored` increments and accelerates
  decay past the threshold.
- **`digest`**: `selectDue` filters/orders/caps correctly and honors `reminders_paused`;
  `isQuietHours` handles the midnight wrap; `cadenceGate` enforces the min-gap and the `matters`
  pull-forward.
- **`cron`** (against fake D1 + a capturing `notify` stub): lazy-initializes freshly-`tagged` items;
  selects due items per user, advances and writes back state, holds during quiet hours / pause /
  cadence gap, and is idempotent on a double-run (no double-advance, no double-send).
- **`tag()` + identity**: extend the PRD 03 pending-store test — `tag()` leaves reminder columns
  unset (cron-owned), and writes stamp `user_id` from the `meta` store.
- **Worker upsert disjointness**: extend `worker-sync` test — the device upsert neither sets nor
  overwrites the five reminder-state columns (excluded from `DO UPDATE`), and does carry `user_id`.
- DOM/Web-Push/device-pull are 04b → a `docs/manual-verification.md` note records that 04a ships
  headless (no user-visible change yet; verified by the cron advancing D1 state + the stubbed digest).

## 9. Acceptance criteria (04a slice of PRD §12)
- [ ] A Cron Worker runs on schedule, reads D1 for due tracked items per user, and calls `notify`
      with a capped, importance-ordered digest (stub in 04a).
- [ ] `matters` and `normal` items follow visibly different spacing schedules.
- [ ] Items resurface on a widening schedule and age out to `expired` (not deleted) past their horizon.
- [ ] Done retires; snooze defers one cycle without penalty; untouched cycles increment ignore-count
      and accelerate decay past the threshold; opened resets ignore-count without retiring.
- [ ] The digest is capped (≤5) and importance-ordered; overflow waits.
- [ ] Quiet hours / pause / cadence gate emission; a digest due in quiet hours is held.
- [ ] The cron is idempotent per cycle: no double-send or double-advance on retry.
- [ ] The cron lazy-initializes a freshly-`tagged` item into the loop with a correct initial `next_due_at`.
- [ ] The device sync path never writes or clobbers the server-owned reminder-state columns; `user_id` is carried through.
- [ ] Topic tags do not affect scheduling.

## 10. Deferred / open (noted, not built in 04a)
- Web Push delivery, review-view UI, device pull/reconciliation, account transfer → 04b.
- §10 tuning constants (spacing numbers, cadence gaps, ignore threshold, quiet-hours default, digest
  cap) are sane defaults in one place, expected to change with real use.
- "Opened soft-retire" and "expired second-chance resurfacing" remain v1-explicit-only (PRD §10).
