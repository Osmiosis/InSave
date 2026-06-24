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
- [ ] `/tag.html` lists only `pending` items (captured + promoted) together, newest first.
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
