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
