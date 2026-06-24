# PRD 04c — Reminder Interaction — Design Spec

**Date:** 2026-06-24
**Project:** InSave
**Source PRD:** `PRD's/04-reminder-engine.md` (§5 leaving the loop, §8.2 receiving, §9.1 read-back, §9.5 response handling)
**Depends on:** PRD 04a (engine, `response.ts`, `ReminderRepo`, reminder state), PRD 04b (Web Push delivery, `assemblePayload`, SW push handler, `user_id`)
**Status:** Locked (implemented)

---

## 1. Purpose

Close the reminder loop. 04a computes due items, 04b pushes a notification — but the user can't yet
*act* on a reel, and a reinstall loses everything (sync is push-only). This cycle adds: the device
**pull/read-back** path from D1 (restore + refresh), a **review-view UI** listing the live active
queue, and **Done / Snooze / Open** actions reaching the server — from both the review view and the
notification's own action buttons. This is the final core-loop PRD.

## 2. Scope

**In scope (04c):**
- `GET /api/pull` + client `pullAndReconcile()` + the pure reconciliation rule (restore/refresh).
- `POST /api/action` (bulk, 1..N ids) applying `done`/`snooze`/`open` to server-owned state.
- The review-view page (`review.html` + `src/review-view.ts`) — live active queue with per-item actions.
- Notification **Done/Snooze** action buttons (payload carries `user_id` + `ids`; SW routes them).
- `ReminderRepo` gains `listByUser`, `getById`; D1 row → `PendingCapture` deserialization.

**Out of scope (still deferred):** account-based multi-device transfer; guided onboarding; per-tag
scheduling; any change to the spacing/cadence constants (04a owns them); cross-device *conflict*
beyond the single-user restore/refresh rule below (no concurrent multi-device editing in v1).

## 3. The action path (`POST /api/action`)

One endpoint serves both the review view (one id) and notification buttons (the digest's ids):
- Body `{ user_id: string, ids: string[], action: "done" | "snooze" | "open" }`.
- `parseAction(body)` validates: `user_id` non-empty string, `ids` non-empty string array, `action`
  in the allowed set. Invalid → 400.
- For each id: `repo.getById(id)` → if found, `applyAction(item, action, Date.now())` →
  `repo.writeReminderState(id, patch)`. Unknown ids are skipped (idempotent). Returns 200 `{ ok: true }`.
- **`applyAction(item, action, now)`** (pure, `src/reminder/action.ts`) reuses 04a `response.ts`:
  - `done` → `markDone(item)` → `{ reminder_status: "done" }`
  - `snooze` → `snooze(item, now)` → `{ reminder_status: "active", next_due_at: now + initialDelay }`
  - `open` → `markOpened(item)` → `{ ignored_count: 0 }`

  These write only server-owned columns, consistent with the 04a ownership rule.

## 4. The pull / reconcile path

- **`GET /api/pull?user_id=…`** → `repo.listByUser(userId)` → `{ items: PendingCapture[] }`. Missing/
  empty `user_id` → 400 (`parsePull(query)` validates).
- **`repo.listByUser(userId)`** (D1) selects all the user's `pending_capture` rows and maps each via
  **`rowToPending(row)`** (pure, `src/reminder/row-to-pending.ts`): `topic_tags` `JSON.parse` → array
  (null → undefined), `parse_ok` int → bool, nullable reminder/import fields normalized,
  `synced: true`. Shared by worker (read path) so the wire shape is a real `PendingCapture`.
- **Client `pullAndReconcile()`** (`src/reminder-pull.ts`): `getUserId()` → `GET /api/pull` → in one
  IndexedDB transaction, for each remote row write `mergePulled(localById, remote)`.
- **`mergePulled(local, remote)`** (pure, `src/reminder/reconcile-pull.ts`) — the reconciliation rule:
  - `local` absent → `{ ...remote, synced: true }` (reinstall restore: take the row whole).
  - `local` present → `{ ...local, reminder_status, next_due_at, cycle_count, ignored_count,
    last_surfaced_at }` taken from `remote`; every device-owned field (`status`, `topic_tags`,
    `importance`, `description`, identity, `synced`) kept from `local`.
  Idempotent; never clobbers local user-content with server data, never resurrects a locally-dismissed
  item's content.

## 5. Notification action buttons

- **`assemblePayload(userId, due)`** (extended from 04b) now returns
  `{ title, body, count, user_id, ids }` where `ids = due.map(d => d.id)`. `makeNotify` passes
  `userId`.
- **SW `push`** (`src/sw.ts`): `showNotification(title, { body, tag: "insave-digest", data: { ids,
  user_id }, actions: [{ action: "done", title: "Done" }, { action: "snooze", title: "Snooze" }] })`.
- **SW `notificationclick`**: close the notification; if `event.action` is `"done"`/`"snooze"`,
  `event.waitUntil(fetch("/api/action", { method: "POST", headers, body: JSON.stringify({ user_id,
  ids, action: event.action }) }))` (acts on the whole digest, no window needed); otherwise (plain
  tap) focus/open **`/review.html`** (the 04b handler's `"/"` becomes `/review.html`).

## 6. The review view

- **`review.html` + `src/review-view.ts`** — added to `vite.config.ts` `input` and the SW `SHELL` so
  the page shell loads offline. Actions require the network; a failed `/api/action` re-enables the
  button with a quiet retry hint (the cron re-surfaces an un-acted item regardless, so nothing is lost).
- On load: `pullAndReconcile()`, then render the **live active queue** — the user's active reminder
  pile: `items.filter(i => i.reminder_status === "active")` sorted matters-first then soonest
  `next_due_at`. Empty → a calm "Nothing to revisit" message.
- **Card** (reuses the `tag-view` card style): author (`@author` or URL host), caption/description +
  reel/post badge when present, and three controls:
  - **Done** → `POST /api/action {ids:[id], action:"done"}` → item retires (`reminder_status=done`) →
    remove the card.
  - **Snooze** → `action:"snooze"` → item's next reminder is pushed out (stays active) → optimistically
    remove the card; the cron re-surfaces it when the deferred time passes.
  - **Open in Instagram** → link-out to `canonical_url` **and** `action:"open"` (resets ignore-count;
    the card stays); unparsed items (`parse_ok=false`) show a "needs review" affordance instead.
  Each button optimistically updates the card; a failed POST re-enables it with a quiet hint.
- `index.html` gains a "Review reminders →" link.

## 7. Data model

No new tables or columns. 04c only *reads back* existing `pending_capture` rows (the 04a reminder
columns + `user_id`) and writes the same server-owned columns the cron already owns. `rowToPending`
exists because D1 stores `topic_tags` as JSON text and booleans as integers; the pull path must
rehydrate them to the `PendingCapture` shape.

## 8. Testing

Node-testable units, TDD (vitest; fake-indexeddb where IDB is involved):
- **`applyAction`** — `done`/`snooze`/`open` produce the right server-owned patch (snooze uses the
  importance initial delay; open resets `ignored_count`; done sets status).
- **`mergePulled`** — absent local inserts whole (`synced:true`); present local overlays only the five
  server-owned fields and preserves device-owned content (tags/importance/status); idempotent.
- **`rowToPending`** — `topic_tags` JSON string → array (and null → undefined), `parse_ok` 1/0 → bool,
  nullable fields normalized, `synced:true`.
- **`assemblePayload`** — now includes `user_id` + `ids` (update the 04b test); body singular/plural
  unchanged.
- **`parseAction`** / **`parsePull`** — a valid body/query passes; each malformed case (missing
  user_id, empty ids, bad action, missing query) returns null/400.
- **Manual / on-device** (`docs/manual-verification.md`): the review-view UI + actions, `pullAndReconcile`
  on launch and reinstall restore, the notification Done/Snooze round-trip updating D1, and the
  `/api/pull` + `/api/action` D1 paths end-to-end (the adapter, SW handlers, and DOM glue are not unit-tested).

## 9. Acceptance criteria (closing PRD §12)
- [ ] Tapping a notification opens the review view; its Done/Snooze buttons update D1 reminder state without opening the app.
- [ ] The review view lists the live active queue (matters-first, soonest-due), each card openable to Instagram.
- [ ] Done retires an item (`reminder_status=done`, leaves the queue); Snooze defers it one cycle (stays active, no ignore penalty); Open resets ignore-count without retiring.
- [ ] `GET /api/pull` returns the user's tracked items; a fresh reinstall restores them locally with no data loss.
- [ ] Reconciliation is idempotent: a pull never clobbers newer local tags/importance and never resurrects a locally-dismissed item's content.
- [ ] `POST /api/action` applies to 1..N ids, skips unknown ids, and rejects a malformed body (400).
- [ ] All action writes touch only server-owned reminder columns (device content untouched).

## 10. Deferred / open (noted, not built)
- Account-based multi-device transfer + true concurrent multi-device conflict resolution.
- A "snoozed"-status surface (snooze keeps the item `active` with a pushed-out `next_due_at` in v1, so
  a snoozed item can reappear in the review pile before its deferred time; a distinct `snoozed` state
  that hides it until due is a later refinement — it would need the cron to flip `snoozed`→`active`).
- Offline action queueing (a failed `/api/action` shows a retry hint rather than queuing; the cron
  re-surfaces an un-acted item anyway, so nothing is lost).
- Re-surfacing `expired` items on their own (PRD §10 — explicit re-activation only).
