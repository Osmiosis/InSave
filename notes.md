# InSave — PRD Notes

Chronological summary of each PRD as it's worked on. Newest entries appended at the bottom.

---

## PRD 01 — Capture + Share Target — 2026-06-16

**What it is:** The capture fast path. An installed Android PWA that registers in Instagram's
native share sheet so a user can save a reel into InSave in under a second and get straight back
to scrolling. No tagging or enrichment at capture time — those are deferred to later PRDs.

**Decisions made:**
- Stack: plain Vite + TypeScript (no UI framework), Cloudflare Pages + one Worker.
- Backend store: Cloudflare D1 (SQLite). Local queue: IndexedDB.
- Confirmation UX: brief auto-dismissing toast.
- Sync retry: `online` event + on-launch drain (no Background Sync API).

**How it works:**
- The web manifest declares a `share_target` (POST, multipart) at `/share`.
- The service worker intercepts that POST, does all synchronous work locally
  (parse → normalize URL → dedupe-check → write IndexedDB), then 303-redirects to a
  self-contained toast page. No network on the critical path, so capture works fully offline.
- A fire-and-forget sync drains unsynced records to the Worker `/api/sync`, which upserts into
  D1 idempotently. Drain re-triggers on reconnect and on SW activation.
- Unparsed payloads are stored (`parse_ok = false`), never dropped. Duplicates collapse on the
  canonical URL.

**Delivered (verified):** `tsc` clean, 20/20 unit tests (url-normalize, pending-store, capture,
sync), clean production build emitting `/sw.js` + assets at site root. Final adversarial review
passed after fixing an offline toast-page caching gap (toast script inlined so the page renders
offline from the shell cache).

**Still manual / open:**
- On-device acceptance items (share-sheet appearance, real Instagram payload shape, sub-1s feel,
  offline→sync) tracked in `docs/manual-verification.md`.
- Replace the placeholder D1 `database_id` in `wrangler.toml` before remote deploy.

**Artifacts:** spec `docs/superpowers/specs/2026-06-16-prd01-capture-share-target-design.md`,
plan `docs/superpowers/plans/2026-06-16-prd01-capture-share-target.md`.

**Next PRDs:** 02 Backlog Import, 03 Tag Queue, 04 Reminder Engine.
