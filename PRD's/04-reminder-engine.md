# PRD 04: Reminder Engine

**Project:** InSave
**Component:** The brain — server-side spaced resurfacing of tracked reels
**Platform target (v1):** Cloudflare Cron Worker + D1 (read-back) + Web Push, paired with the Android PWA
**Status:** Draft

---

## 1. Purpose

Deliver on InSave's core promise: the reels you saved and meant to come back to actually come back to you, at the right rhythm, until you've dealt with them. This is the feature the whole product exists for. Capture (PRD 01), import (PRD 02/02b), and tagging (PRD 03) all exist to feed this engine clean, prioritized items. If the reminder loop isn't reliable and isn't respectful of the user's attention, none of the rest matters.

The engine's two jobs: decide **what is due** (the spacing brain) and deliver it **without becoming annoying** (the digest + quiet-hours discipline). The "rigour" of InSave lives here, in the spacing curve and the response-handling logic, not in volume.

## 2. Architecture decision (settled)

Reminders run **server-side**: a Cloudflare Cron Worker wakes on a schedule, reads D1 for due items, and sends Web Push notifications to the user's device, even if InSave hasn't been opened in days.

This was chosen over an on-device service-worker scheduler because the product's whole promise is "we'll remember for you," and an on-device scheduler can't keep that promise for the user who needs it most: a service worker only runs when the OS wakes it, so the person who hasn't opened InSave in three days, exactly the person who forgot, would get nothing. Server-side reaches them regardless.

A required consequence, treated as a feature: this build adds the **D1 read-back path** that PRD 03 left missing (sync was push-only). D1 becomes a real source of truth the engine reads from, which also fixes single-device data fragility (a reinstall / new phone can restore from D1 rather than losing everything). Server-side reminders and durable data are the same piece of work.

## 3. Scheduling model: spaced resurfacing (settled)

An item does not get one reminder and then vanish. It **resurfaces on a decaying schedule** (spaced-repetition style) until the user acts on it or it ages out. This directly attacks the founding problem ("I save things and completely forget them"): a single notification swiped away at a bad moment must not lose the reel forever.

- Each tracked (`tagged`) item has a **next-due time**. When the cron runs, items whose next-due time has passed are candidates for that cycle's digest.
- After an item is surfaced, its next-due time is pushed out by a **widening interval** (gaps grow each cycle), so an un-acted item nags less and less rather than at a constant drumbeat.
- An item eventually **ages out** (stops resurfacing) after enough un-acted cycles or enough elapsed time, moving to a dormant "expired" state. Expired items are not deleted (browsable, re-activatable), they just stop nudging.

## 4. How importance shapes the schedule (settled)

The one-time binary importance mark from PRD 03 (`normal` | `matters`) is the **primary dial on the spacing curve**. This is what makes the explicit importance tap worth having asked the user for: it visibly changes behaviour.

- **`matters`** items: resurface **sooner**, persist through **more cycles**, and **age out slower** (or not at all within v1 horizons). InSave tries harder, for longer, to get these in front of the user.
- **`normal`** items: a gentler, more forgettable schedule, wider initial gap, fewer cycles, age out sooner.
- Importance sets the *parameters* of the spacing curve (initial delay, growth factor, max cycles / max age), not a separate code path. One curve, two parameter sets.

## 5. How an item leaves the loop (settled, with one open sub-question)

InSave cannot see whether the user actually watched the reel (no Instagram API). So "done" is always a **user action**, never inferred from Instagram.

- **Done / got it:** the user taps "done" (on the notification action or in-app). The item **retires** from the reminder loop (state → `done`), stops resurfacing, stays browsable.
- **Snooze / remind me later:** the user can push an item out by one cycle (or a chosen short delay) without retiring it. Snooze is an explicit "not now, but keep it alive."
- **Repeated ignore → back off (DEFAULT, overridable):** if the user is *served* an item across several cycles and neither acts nor snoozes (pure ignore), the engine reads that as "this probably isn't as important as marked" and **accelerates that item's decay** (widens its gaps faster and/or ages it out sooner). Rationale: the alternative (keep nagging at full strength) trains the user to tune InSave out entirely, which is fatal for a reminder app. Better to quietly back off a few items than to lose the user's trust in all notifications. (See §10 open question — this is the one behavioural call most worth revisiting with real use.)

## 6. Delivery discipline: batching, cadence, quiet hours (settled)

The fastest way to get InSave uninstalled is to fire many separate notifications. The engine protects the user from itself.

- **Digest, not per-item:** a cron cycle sends at most **one** notification summarizing the due items ("3 saved reels worth revisiting"), not one push per item. Tapping it opens a review view listing them.
- **Conservative cadence (default):** the digest fires on an **every-few-days** rhythm by default, not hourly or even necessarily daily. Over-notifying is the failure mode; start quiet. (`matters` items can pull the *next* digest earlier, but the engine still batches rather than interrupting immediately.)
- **Quiet hours:** no notifications during the user's night/quiet window. A digest that would fire in quiet hours is held to the next allowed window.
- **Cap per digest:** a digest surfaces a bounded number of items (the most-due / highest-importance first); overflow waits for the next cycle. The user is never handed a wall of 30 items.
- **Frequency is user-adjustable later** (model supports a per-user cadence setting); v1 ships a sane conservative default.

## 7. Topic tags in v1 (settled)

Topic tags (PRD 03) are **organizational, not scheduling-driving, in v1.** They do not change an item's cadence or priority. They're for filtering and browsing ("show me my 'claude tricks'"). Letting tags carry per-tag priority is a clean later enhancement, deliberately deferred so the scheduling brain stays keyed on the three things that matter: importance, time, and the user's responses. Keeping tags out of the schedule keeps the model legible.

## 8. User flow

### 8.1 Becoming due
1. An item becomes `tagged` (PRD 03) → it enters the reminder loop with an initial next-due time set from its importance parameters.
2. The Cron Worker runs on its schedule, reads D1 for items whose next-due time has passed (and whose user is within an allowed notification window).
3. Due items are grouped per user into a single digest (respecting cap + quiet hours).

### 8.2 Receiving a reminder
1. The user gets one push: "N saved reels worth revisiting."
2. Tapping it opens a **review view** listing the due items, each showing what InSave has: caption (for backlog items, free from the export), author, reel/post badge, saved date, and a link to open the original in Instagram.
3. Per item, the user can: **open** it (link out), mark **done** (retire), or **snooze** (defer one cycle). Items left untouched are re-scheduled by the spacing curve and counted toward the back-off logic.

### 8.3 Aging out
- Items that go un-acted past their importance-set horizon move to `expired` (stop nudging, stay browsable/re-activatable). Nothing is deleted.

## 9. Functional requirements

### 9.1 D1 read-back path (new, required)
- A read path MUST let the Worker query D1 for a user's tracked items and their reminder-state fields (next-due, cycle count, importance, status). This is the path PRD 03's push-only sync lacked.
- The device MUST be able to **pull** from D1 to restore/refresh local state (fixes single-device fragility). Reconciliation MUST be idempotent and not clobber newer local changes (define a clear last-write/ownership rule; reminder-state fields are server-owned, user-content fields are device-owned).

### 9.2 Reminder state per item
Each tracked item MUST carry reminder-state fields (server-owned):
- `reminder_status` — "active" | "snoozed" | "done" | "expired"
- `next_due_at` — when it's next eligible to surface
- `cycle_count` — how many times it's been surfaced
- `ignored_count` — consecutive surfaced-but-untouched cycles (drives back-off)
- `last_surfaced_at`
- (reads existing) `importance`, `topic_tags`, `status` (must be `tagged`), timestamps

### 9.3 The Cron Worker (the engine)
- MUST run on a schedule (Cloudflare Cron Triggers).
- Each run: for each user, find items with `reminder_status = active` and `next_due_at` passed, within the user's allowed window; assemble a capped, importance-ordered digest; send one Web Push; update each surfaced item's `next_due_at` (widened by the spacing curve), `cycle_count`, `last_surfaced_at`.
- MUST respect quiet hours and the per-user cadence (default conservative).
- MUST be idempotent per cycle (a ret* or double-run must not double-send or double-advance an item).

### 9.4 Spacing curve
- MUST compute `next_due_at` from importance parameters (initial delay, growth factor) and `cycle_count`.
- MUST age items out to `expired` past their importance-set max cycles / max age.
- `matters` vs `normal` MUST produce visibly different schedules (sooner+persistent vs gentler+shorter).

### 9.5 Response handling
- **Done** → `reminder_status = done`, stops surfacing.
- **Snooze** → push `next_due_at` out one cycle (or chosen delay), keep active, do NOT increment `ignored_count`.
- **Surfaced but untouched** (neither done nor snoozed, nor opened) → increment `ignored_count`; once it crosses a threshold, **accelerate decay** (faster gap growth and/or earlier age-out). [Default behaviour; see §10.]
- **Opened** (user tapped through to the reel) → treated as engagement; reset `ignored_count` (they're paying attention), but do NOT auto-retire (opening ≠ done; they may want it again). Whether opening should soft-retire is an open question (§10).

### 9.6 Web Push
- MUST implement Web Push (VAPID keys, push subscriptions stored per user/device).
- The PWA MUST register a push subscription (this requires the installed PWA + notification permission; onboarding handles the permission prompt).
- Notification actions SHOULD include at least "review" (open digest); per-item done/snooze happen in the review view.
- MUST handle subscription expiry/refresh gracefully.

### 9.7 Settings (minimal v1)
- The user MUST be able to set/adjust **quiet hours** and ideally a coarse **cadence** (e.g. "remind me: often / balanced / rarely"). A sane conservative default ships; the user can dial it.
- The user SHOULD be able to turn reminders off entirely (pause) without losing data.

## 10. Open questions (genuinely undecided — revisit with real use)

- **Repeated-ignore semantics (the big one):** default is "ignore → back off / accelerate decay" (§5, §9.5), on the theory that nagging trains users to ignore everything. The alternative reading is "ignore = bad timing, keep trying at full strength." This is the single behavioural call most worth validating against real usage; the spacing parameters are written to make flipping it a config change, not a rewrite.
- **Does "opened" soft-retire an item?** Opening the reel is engagement but not necessarily "done." v1: opening resets ignore-count but doesn't retire. May want a gentler auto-decay after an open.
- **Exact spacing constants** (initial delays, growth factor, max cycles for each importance level, default cadence interval, quiet-hours default, digest cap): these are tuning values, set sane defaults, expect to adjust them once it's running on a real backlog. Don't over-engineer the first numbers.
- **Cross-device pull conflict rules:** the precise ownership split (server-owned reminder state vs device-owned user content) needs nailing down when the read-back path is built, so a phone restore doesn't resurrect retired items or clobber fresh tags.
- **Re-surfacing expired items:** should `expired` items ever come back on their own (e.g. a long-dormant "second chance"), or only via explicit user re-activation? v1 leans explicit-only.

## 11. Data model (additions / reuse)

Extends the tracked `pending_capture` record (status must be `tagged`) with **server-owned reminder-state fields** (§9.2): `reminder_status`, `next_due_at`, `cycle_count`, `ignored_count`, `last_surfaced_at`.

New per-user settings: `quiet_hours`, `cadence`, `reminders_paused`, plus Web Push `subscription` data (endpoint + keys) per device.

D1 is the source of truth for reminder-state (server-owned); the device pulls these read-only and owns user-content fields (tags, importance, dismissals). Reconciliation rule per §9.1.

## 12. Acceptance criteria

- [ ] A Cron Worker runs on schedule, reads D1 for due tracked items, and sends Web Push.
- [ ] Reminders arrive even when the PWA has not been opened (the core promise).
- [ ] `matters` and `normal` items follow visibly different spacing schedules.
- [ ] Items resurface on a widening schedule and age out to `expired` (not deleted) past their horizon.
- [ ] Done retires an item; snooze defers it one cycle without penalty; untouched cycles increment ignore-count and (default) accelerate decay past a threshold.
- [ ] Reminders are batched into a single capped digest per cycle, never one-push-per-item.
- [ ] Quiet hours are respected; a digest due in quiet hours is held to the next window.
- [ ] The user can set quiet hours / cadence and can pause reminders without data loss.
- [ ] The D1 read-back path lets a device restore tracked items + state (no data loss on reinstall).
- [ ] Reconciliation is idempotent: a pull doesn't resurrect retired items or clobber newer local tags.
- [ ] The cron is idempotent per cycle: no double-send or double-advance on retry.
- [ ] Topic tags do not affect scheduling in v1 (organizational only).

## 13. Dependencies / sequencing notes

- Consumes `tagged` items from PRD 03 (importance, tags, timestamps already present).
- Backlog items already carry captions (PRD 02b), so review-view cards are informative without any network enrichment. Live captures show author/URL only — the link-out covers memory-jogging there.
- Requires building the D1 read-back path PRD 03 deferred; this is in scope here and is also the data-durability fix.
- Web Push requires the installed PWA + notification permission (onboarding concern; the engine assumes a valid subscription exists and degrades gracefully if not).

---

*Prev: 01 Capture + Share Target, 02 Backlog Import, 02b Format Correction, 03 Tag Queue. This is the final core-loop PRD.*
