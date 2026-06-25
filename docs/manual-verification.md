# PRD01 Manual Verification (real Android device)

These acceptance items require an installed PWA + live Instagram and cannot be unit-tested.

## Setup
1. Deploy to Cloudflare Pages over HTTPS (or use `wrangler pages dev` with a tunnel).
2. On an Android device, open the site in Chrome and "Add to Home screen" (install).
3. Create the D1 database: `wrangler d1 create insave`, paste the returned id into
   `wrangler.toml` (`database_id`, currently the placeholder `REPLACE_WITH_D1_ID_AFTER_CREATE`),
   then apply `schema.sql` remotely: `wrangler d1 execute insave --file=schema.sql`.
4. Deploy the Worker: `wrangler deploy`.

## Checklist (PRD §9)
- [ ] Installed PWA "InSave" appears in Instagram's Android share sheet.
- [ ] Sharing a reel shows the "Saved. Tag it later." toast and returns to Instagram.
- [ ] Sharing the SAME reel again shows "Already in InSave." and creates no duplicate
      (verify one row in D1: `SELECT count(*) FROM pending_capture WHERE canonical_url=...`).
- [ ] Confirm which payload field carries the URL (log `raw_payload`); handler recovers it.
- [ ] Capture feels sub-1s on a mid-range device.
- [ ] Turn on airplane mode, share a reel → still saves + toast; turn network back on →
      record appears in D1 within a few seconds (online drain) or on next app launch.
- [ ] Share something with no Instagram URL → "Saved — needs a look later.",
      row stored with `parse_ok = 0`, nothing dropped.

## Notes
- The capture path runs entirely in the service worker against IndexedDB; the Worker/D1
  is sync-only and off the critical path, so airplane-mode capture must still succeed.
- `/share` is handled by the SW `fetch` interceptor (no server route); `/captured.html`,
  `/manifest.webmanifest`, `/sw.js`, and `/icons/*` all deploy at the site root.
- Icons are solid-color placeholders; final artwork is an onboarding/design concern (out of scope).

## PRD02 Backlog Import (real Instagram export)

Requires a real "Download Your Information" export from Instagram.

### Setup
- Apply the new D1 columns. Fresh local DB: `wrangler d1 execute insave --local --file=schema.sql`.
  Existing remote DB (the `saved_at`/enrichment columns must be added by ALTER, since
  `CREATE TABLE IF NOT EXISTS` will not modify an existing table):
  `wrangler d1 execute insave --command "ALTER TABLE pending_capture ADD COLUMN saved_at INTEGER; ALTER TABLE pending_capture ADD COLUMN title TEXT; ALTER TABLE pending_capture ADD COLUMN thumbnail TEXT; ALTER TABLE pending_capture ADD COLUMN description TEXT;"`

### Checklist (PRD §10)
- [ ] Upload the export `.zip` on `/import.html` → full backlog lists with NO network calls to Instagram (check devtools Network).
- [ ] Upload the extracted `saved_posts.json` directly → same result.
- [ ] Items are grouped by author and ordered by recency; per-author counts shown.
- [ ] A malformed/wrong file shows the safe error banner, no crash.
- [ ] "Keep" / "Keep all from @author" promotes items; they appear in D1 with `source='import'` and `saved_at` set.
- [ ] Skipped/dismissed items are NOT in D1 and generate no reminders, but remain in the local backlog (dormant).
- [ ] Re-uploading the same export adds no duplicates ("N already saved" shown).
- [ ] Confirm the real export's `saved_posts.json` structure matches `parse-saved-posts.ts`; adjust if Instagram changed field names.

## PRD 02b — Backlog import format correction

- [ ] Upload a real Instagram export `.zip`; the importer reads it (no "couldn't read" error).
- [ ] Triage cards show the caption text and a `reel`/`post` badge per item.
- [ ] An item with no caption renders without an empty caption line.
- [ ] Promote an item; in D1 / pending sync its `description` equals the export caption.
- [ ] Both reels (`/reel/`) and posts (`/p/`) appear in triage.

## PRD 03 — Tag Queue

### Setup
- Apply the new D1 columns. Fresh local DB: `wrangler d1 execute insave --local --file=schema.sql`.
  Existing remote DB (add by ALTER, since `CREATE TABLE IF NOT EXISTS` won't modify an existing table):
  `wrangler d1 execute insave --command "ALTER TABLE pending_capture ADD COLUMN topic_tags TEXT; ALTER TABLE pending_capture ADD COLUMN importance TEXT; ALTER TABLE pending_capture ADD COLUMN tagged_at INTEGER; ALTER TABLE pending_capture ADD COLUMN author TEXT; ALTER TABLE pending_capture ADD COLUMN media_type TEXT;"`

### Checklist (PRD §10)
- [ ] First run (no tags yet) shows greyed-out non-binding example chips; they do not apply.
- [ ] Typing a new tag + Tag processes the item; that tag appears as a real one-tap chip next session.
- [ ] Tapping an existing chip processes a typical item in a single tap.
- [ ] "Matters" elevates importance in one optional tap; default is normal; never re-prompted.
- [ ] Dismiss removes the item and offers Undo; Undo restores it to the queue.
- [ ] Tagged/dismissed items leave the queue; in D1 their `status`, `topic_tags` (JSON), `importance`, `tagged_at` are set (tagged) — check `SELECT status, topic_tags, importance FROM pending_capture`.
- [ ] Promoted import items show `@author`, caption, and a reel/post badge on the card; share-captures fall back to the URL host.
- [ ] Each card opens the original reel in Instagram (link-out); unparsed items show "needs review" instead.
- [ ] Tag offline → transition drains to D1 on reconnect (status updates, no duplicate rows).

## PRD 04a — Reminder Engine Core (headless)

04a ships no user-visible UI; verify the engine advances D1 state on schedule. Web Push, the
review-view UI, and device pull/restore arrive in 04b.

### Setup
- Apply the new D1 columns + settings table. Fresh local DB: `wrangler d1 execute insave --local --file=schema.sql`.
  Existing remote DB (add by ALTER):
  `wrangler d1 execute insave --command "ALTER TABLE pending_capture ADD COLUMN user_id TEXT; ALTER TABLE pending_capture ADD COLUMN reminder_status TEXT; ALTER TABLE pending_capture ADD COLUMN next_due_at INTEGER; ALTER TABLE pending_capture ADD COLUMN cycle_count INTEGER; ALTER TABLE pending_capture ADD COLUMN ignored_count INTEGER; ALTER TABLE pending_capture ADD COLUMN last_surfaced_at INTEGER;"`
  Then create the settings table + index by re-running `schema.sql` (its `CREATE TABLE/INDEX IF NOT EXISTS` are safe on an existing DB).

### Checklist
- [ ] `wrangler dev --test-scheduled` then trigger the cron (`curl "http://localhost:8787/__scheduled"`): a tagged item with no reminder fields gets `reminder_status='active'` and a future `next_due_at` (lazy init).
- [ ] After making an item due (`next_due_at` in the past) and re-triggering: the cron logs a digest line, advances `cycle_count`, sets `last_surfaced_at`, and pushes `next_due_at` out.
- [ ] A `matters` item gets a sooner `next_due_at` than a `normal` item at the same cycle.
- [ ] Triggering twice in the same hour does not double-advance `cycle_count` or log a second digest (idempotency).
- [ ] Setting `reminders_paused=1` (or a quiet-hours window covering now) suppresses the digest.
- [ ] A device sync of a tagged item never overwrites `reminder_status`/`next_due_at`/`cycle_count` already set by the cron; `user_id` is present on synced rows.

## PRD 04b — Reminder Delivery (Web Push)

### Setup
- Generate VAPID keys once: `npx web-push generate-vapid-keys`.
- Put the **public** key in `src/push-config.ts` (`VAPID_PUBLIC_KEY`) and `wrangler.toml` `[vars]`;
  set the **private** key as a secret: `wrangler secret put VAPID_PRIVATE_KEY`; set `VAPID_SUBJECT`
  to a real `mailto:` in `wrangler.toml`.
- Create the subscriptions table: re-run `schema.sql` (its `CREATE TABLE IF NOT EXISTS` is safe), or for
  an existing remote DB run the `CREATE TABLE push_subscriptions ...` + `idx_subs_user` statements.

### Checklist
- [ ] On the installed PWA, tap "Enable reminders" → permission prompt → a row appears in `push_subscriptions` for the device's `user_id` (`SELECT * FROM push_subscriptions`).
- [ ] Make an item due and trigger the cron (`wrangler dev --test-scheduled` + `curl ".../__scheduled"`): a single notification "N reels worth revisiting" arrives — with InSave fully closed.
- [ ] Tapping the notification opens/focuses InSave.
- [ ] Two due items in one cycle still produce ONE notification (the `insave-digest` tag collapses it).
- [ ] Unsubscribe in the browser (or use a stale endpoint) then trigger the cron → the dead row is pruned from `push_subscriptions` (404/410 → delete).
- [ ] The VAPID private key is only a Worker secret (not in the repo); `git grep` finds no private key.

## PRD 04c — Reminder Interaction (review + pull + actions)

No schema changes; uses 04a/04b setup (reminder columns, VAPID, push_subscriptions).

### Checklist
- [ ] Open `/review.html` (or tap a notification) → the active reminder queue lists, matters-first; each card opens the reel in Instagram.
- [ ] Tap **Done** on a card → in D1 the item's `reminder_status='done'` and it leaves the queue on reload.
- [ ] Tap **Snooze** → `next_due_at` moves out, `reminder_status` stays `active`, the card leaves the list.
- [ ] Tap **Open in Instagram** → the reel opens and the item's `ignored_count` resets to 0 in D1.
- [ ] On the push notification, tap the **Done** / **Snooze** action button (app closed) → D1 reflects it for every item in the digest.
- [ ] Reinstall the PWA (clear site data) → open the app → `pullAndReconcile` restores the tracked items from D1 (no data loss).
- [ ] Re-pull after a local tag edit → the pull keeps the local tag/importance and does not resurrect a locally-dismissed item's content (reconciliation is no-clobber).
- [ ] `POST /api/action` with an unknown id is a no-op (200); a malformed body returns 400.

## PRD 05a — Collections (remote D1 migration)

> **APPLIED 2026-06-25** to prod `insave` (`269f5f49-…`): `collection_id` column, `collections`
> table, and `idx_collection` / `idx_collections_user` all verified present. Do NOT re-run the
> `ALTER TABLE` (it is not idempotent and will error). Ordering rule for any fresh environment:
> **run this migration BEFORE deploying the worker** — the sync rail reads `collection_id`.

Apply once against the deployed DB (existing rows untouched; `collection_id` null ≡ "Saved"):

    npx wrangler d1 execute insave --remote --command \
      "ALTER TABLE pending_capture ADD COLUMN collection_id TEXT;"
    npx wrangler d1 execute insave --remote --command \
      "CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, is_default INTEGER NOT NULL DEFAULT 0);"
    npx wrangler d1 execute insave --remote --command \
      "CREATE INDEX IF NOT EXISTS idx_collections_user ON collections (user_id);"
    npx wrangler d1 execute insave --remote --command \
      "CREATE INDEX IF NOT EXISTS idx_collection ON pending_capture (user_id, collection_id);"

### Checklist
- [ ] After migration, capture an item (no collection chosen) → in D1 its `collection_id` is NULL and it reads as "Saved".
- [ ] Move an item to a new collection → `/api/sync` round-trips `collection_id`; D1 reflects it; reminder columns unchanged.
- [ ] Collections list syncs via `/api/collections`; "Saved" is `is_default=1`, exactly one per user, and cannot be deleted.

## PRD 05b — Collections UI

No schema change (05a already added the column/table). Apply the 05a remote
migration first if not already done.

### Checklist
- [ ] Open `/` → the collections home lists "Saved" first with a reel count; Import / Review / Enable-reminders links still work.
- [ ] Tap **+ New collection**, name it → it appears in the list (count 0).
- [ ] Open a collection → its reels list with author/badge/caption/link-out; "Saved" also shows reels captured with no collection (null-is-Saved).
- [ ] On a reel, tap **Move** → pick another collection → the reel leaves this list; open the target → it's there. In D1 its `collection_id` updated; reminder columns unchanged.
- [ ] **Rename** a non-default collection → the new name shows and persists after reload.
- [ ] **Delete** a non-empty collection → choose **Move to Saved** → reels appear under "Saved", collection gone. Repeat with **Delete the reels too** → reels gone from all views (status=dismissed in D1), collection gone.
- [ ] "Saved" shows no rename/delete affordance and cannot be deleted.
- [ ] **Capture zero-tap:** share a reel from Instagram, do nothing → toast shows, auto-returns; the reel is in "Saved".
- [ ] **Capture one-tap:** share a reel, tap a collection chip on the captured screen → toast flips to "Moved to X ✓", returns; the reel is in X (not Saved).
- [ ] **Capture offline:** with network off, share a reel → it still saves to "Saved" (chips may not appear; that's expected).
- [ ] After any change, with network on, confirm `/api/sync` and `/api/collections` received the updates (collection list + `collection_id`s present in D1).

## PRD 05c — Collections finish (cleanup view + backlog picker)

No schema change (05a covered it). Reinstall/refresh once so the SW serves the new shell (cache v4).

### Checklist
- [ ] Home shows a "Tidy Saved" link → opens the cleanup view listing unsorted "Saved" reels (including ones captured with no collection).
- [ ] Tap a collection chip on a cleanup card → the reel moves into that collection (gone from cleanup, present in that collection); Undo returns it to Saved.
- [ ] "More…" lists collections beyond the chip cap and moves correctly; "Saved" is not offered as a target.
- [ ] Dismiss on a cleanup card removes it (status=dismissed in D1) with Undo.
- [ ] Old `/tag.html` no longer resolves; `/cleanup.html` loads (SW cache bumped to v4).
- [ ] Import triage: "Keep" still promotes to "Saved" in one tap; "Keep to…" / "Keep all to…" promote into the chosen collection — verify `collection_id` in D1 after sync; reminder columns untouched.
- [ ] Promoting a backlog item with no collection choice lands it in "Saved" (no `collection_id`).
