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

---

## PRD 02 — Backlog Import — 2026-06-16

**What it is:** The differentiator. Lets a user upload their Instagram data export and resurrect
the pile of reels already buried in their Saved folder — instead of InSave starting empty. The
framing is "here is your graveyard, promote the few worth saving": triage a large messy list,
keep the handful that matter, leave the rest dormant. Promoted items flow into the same tracked
set as share-captures (PRD 01), so the future Tag Queue (PRD 03) treats all sources identically.

**Decisions made:**
- Upload: accept BOTH the full export `.zip` (unzipped client-side with `fflate`, locating
  `saved_posts.json` inside) AND a directly-picked `saved_posts.json`.
- Triage UX: group by author, sort by recency; per-item keep/skip PLUS bulk "keep all / dismiss
  all from @author" to get through 200+ items fast.
- Storage split: the full parsed backlog lives only in a NEW `imported_item` IndexedDB store and
  never leaves the device while dormant. Only on promotion does a `pending_capture` record get
  created and synced to D1. (Privacy: the whole archive is never uploaded to a server.)
- Enrichment: built as a swappable `Enricher` interface with a default no-op stub. No real
  oEmbed/scrape fetcher — that risky, ToS-laden decision is explicitly deferred (PRD §7).
- Promotion model: a promoted item STAYS in the backlog store (marked `promoted`, so the
  graveyard stays browsable and re-imports reconcile) AND a linked `pending_capture` (same
  `canonical_url`) is created for the tracked set.

**How it works:**
- Pipeline (all client-side, zero Instagram requests): `zip.ts` (extract) → `parse-saved-posts.ts`
  (defensive parse of `saved_saved_media[]` → url/author/savedAt, seconds→ms) → `normalize-import.ts`
  (reuses PRD 01 `url-normalize.parse` to canonicalize + in-batch dedupe) → `reconcile.ts` (drops
  URLs already known as an imported item or a capture, preserving existing states) →
  `imported-store.ts` (bulk-write dormant).
- Triage UI (`import.html` + `triage-view.ts`): renders `groupAndSort` (author groups, newest
  first) with keep/skip + bulk actions; shows per-author counts and a "N already saved" summary;
  a malformed file shows a safe error banner, never a crash.
- Promotion (`promote.ts`): flips the backlog item to `promoted`, runs the enricher (stub → no
  fields), builds a `source="import"` `pending_capture` (carrying original `saved_at`,
  `captured_at = imported_at`), writes it to the PRD 01 pending store, and fires `drainSync` → D1.
- Shared DB refactor: extracted `src/db.ts` (`openInsaveDB`, IndexedDB **v2**) as the single owner
  of both object stores; `pending-store.ts` now uses it with its public interface unchanged, so
  PRD 01 capture/sync code was untouched.
- D1 + Worker: added nullable `saved_at` / `title` / `thumbnail` / `description` columns (the
  enrichment seam); the sync Worker binds them `?? null`. Existing capture sync is unaffected.

**Delivered (verified):** `tsc` clean, **46/46** unit tests across 12 files (the 20 PRD 01 tests
plus 26 new: imported-store, parser, zip, normalize, reconcile, enrichment, promote, triage),
clean production build with `import.html` + the `importPage` bundle at the dist root. Final
adversarial review passed after fixing two real bugs:
- the sync Worker was acknowledging records it hadn't actually stored (silent data loss on a
  non-conflict insert error) — now it only accepts an id if the row is genuinely present, so real
  failures retry;
- triage `keep()` is now idempotent, so "Keep all" over an already-kept item can't write
  duplicate `pending_capture` rows.

**Still manual / open:**
- On-device acceptance (upload a real export, confirm zero IG requests, bulk keep/dismiss,
  re-import dedupe, promoted items in D1 with `source='import'`) tracked in
  `docs/manual-verification.md`.
- Existing remote D1 needs `ALTER TABLE` for the four new columns (documented); fresh DBs get them
  from `schema.sql`.
- Confirm the real `saved_posts.json` structure against a recent export; the parser is defensive
  but the field names are assumption-based.
- Enrichment remains a stub — the oEmbed-vs-scrape decision is still deferred.

**Artifacts:** spec `docs/superpowers/specs/2026-06-16-prd02-backlog-import-design.md`,
plan `docs/superpowers/plans/2026-06-16-prd02-backlog-import.md`.

**Next PRDs:** 03 Tag Queue, 04 Reminder Engine.

---

## PRD 02b — Backlog Import Format Correction — 2026-06-17

**What it is:** A correction to PRD 02's parser. The real Instagram `saved_posts.json` is a **bare
top-level array** (not a `saved_saved_media` wrapper object), with per-entry data inside a
`label_values` list. The assumed-shape parser failed on every real export; this rewrites it and
harvests the **caption** and **owner username** the real export carries for free — substantially
weakening the "thin data" constraint for backlog items.

**Decisions made:**
- Import BOTH reels and posts; `media_type` ("reel" | "post") derived from the URL path so the
  UI / PRD 04 can distinguish. Nothing the user saved is silently dropped.
- Caption → `pending_capture.description` at promote time (no network); the `Enricher` stays a
  no-op. The risky network-enrichment question is now isolated to live captures (PRD 01) only.
- Scope split: `media_type`/`author` live on `ImportedItem` now; propagating them to
  `pending_capture` + D1 is deferred to PRD 03 (which changes the schema + sync Worker anyway),
  avoiding a throwaway migration.
- Triage cards gain a caption + reel/post badge.
- Legacy tolerance: the old per-entry shape was never real and is dropped; the parser tolerates a
  wrapper *object around the array* for forward-compat, failing safe if neither matches.

**How it works:**
- `parse-saved-posts.ts` rewritten: `resolveEntryList` accepts a top-level array (or a legacy
  `saved_saved_media` wrapper) → per-entry walk of `label_values` for URL (`label==="URL"`),
  Caption (`label==="Caption"`), and owner Username (`title==="Owner"` → `dict[0].dict[]` →
  `label==="Username"`); top-level `timestamp` seconds→ms; `mediaType` from `/reel/` vs `/p/`.
  Fail-safe `ImportError` on invalid JSON, unknown shape, or zero parseable entries; malformed
  entries never crash (defensive `unknown`-guarded access).
- `caption` + `mediaType` flow through `normalize-import.ts` onto each `ImportedItem`;
  `promote.ts` layers `item.caption` over the enricher result as `description` (export wins).
- `triage-view.ts` renders a reel/post badge and the caption text per card.
- The zip nested-path handling (`your_instagram_activity/saved/saved_posts.json`) was ALREADY
  correct from PRD 02; only the in-test fixture shape was refreshed.

**Delivered (verified):** `tsc` clean, **51** tests across **12** files green, clean
production build (`import.html` + `importPage` bundle). Built TDD via subagent-driven development
(implementer + spec + code-quality review per task). `triage-view.ts` has no unit test by design
(it touches `document` at module load; the vitest env is node) — covered by `tsc` + build + a
`docs/manual-verification.md` checklist entry.

**Still manual / open:**
- On-device acceptance (upload a real export, triage shows captions + badges, promoted items'
  `description` equals the export caption) tracked in `docs/manual-verification.md`.
- Live share-captures still arrive URL-only — network enrichment stays deferred, now isolated to
  PRD 01 captures.
- PRD 03 will add the `author` / `media_type` columns to `pending_capture` + D1 and the sync-Worker
  update path for state transitions.
- `saved_collections.json` ignored in v1 (possible future tag-suggestion source).

**Artifacts:** spec `docs/superpowers/specs/2026-06-17-prd02b-backlog-import-format-correction-design.md`,
plan `docs/superpowers/plans/2026-06-17-prd02b-backlog-import-format-correction.md`.

**Next PRDs:** 03 Tag Queue, 04 Reminder Engine.
