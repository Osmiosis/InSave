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

---

## PRD 03 — Tag Queue — 2026-06-24

**What it is:** The deliberate counterpart to capture. A calm page where the user processes the
`pending` reels they captured (PRD 01) and promoted (PRD 02/02b) — assigning a reusable topic tag
and an optional one-time importance mark — turning them into `tagged` tracked items the reminder
engine (PRD 04) will read. Capture stays reflexive; tagging is intentional and separate.

**Decisions made:**
- Single-tag UI in v1 (one tap on a chip applies it and processes the item); `topic_tags` is a list
  in the model so multi-tag can be enabled later with no migration.
- Tag set is **derived**, not a separate synced entity: the chip set = distinct `topic_tags` across
  the user's own `tagged` items (local IndexedDB query). No second sync path.
- Dismissals use a **toast Undo** (reuses PRD 01's toast idea); no separate dismissed-list view.
- First-run shows greyed-out, **non-binding example chips** (disabled) — they demonstrate the gesture
  and never persist as real categories. No hardcoded categories ship.
- One D1 migration adds `topic_tags`/`importance`/`tagged_at` plus `author`/`media_type` (the latter
  two deferred here from PRD 02b). Share-captures leave author/media_type null; cards fall back to the
  URL host.
- `topic_tags` stored as a JSON text column in D1; `importance` defaults to `normal`, elevatable to
  `matters`. No item-detail/edit view in v1 (model permits later edits).

**How it works:**
- Data model: `CaptureStatus` widened to `"pending" | "tagged" | "dismissed"`; `PendingCapture`
  gains `topic_tags?`, `importance?`, `tagged_at?`, `author?`, `media_type?`. IndexedDB bumped to
  **v3** adding a `by_status` index on `pending_capture` (existing rows already carry
  `status="pending"`; only the index is new).
- Store transitions (`src/pending-store.ts`): `listByStatus` (by_status index, newest-first by
  `captured_at`), `tag` (sets status/tagged_at/tags/importance, idempotent), `dismiss`/`restore`
  (flip status), `listDistinctTags` (deduped union across `tagged` items, excludes dismissed). Every
  mutator sets `synced=false`; the caller fires `drainSync`. Injectable `now` clock for deterministic
  tests.
- Sync (`worker/index.ts`): the upsert changed from `ON CONFLICT(id) DO NOTHING` to
  **`DO UPDATE SET`** the mutable columns (`status`, `topic_tags`, `importance`, `tagged_at`,
  `author`, `media_type`, `description`, `saved_at`) — so re-syncing a transition lands; identity
  columns (`id`, `canonical_url`, `raw_payload`, `captured_at`, `source`, `parse_ok`) stay write-once.
  The canonical_url-conflict fallback (confirm-by-SELECT before accepting) is preserved. SQL/bind
  logic extracted as exported `UPSERT_SQL` + `toBind` for unit testing.
- `promote.ts` now carries `author` + `media_type` onto the promoted `pending_capture` (the PRD 02b
  deferral landed here).
- UI: new `tag.html` + `src/tag-view.ts` (added to `vite.config.ts` input and the SW `SHELL` so the
  queue opens offline; `index.html` gains a "Tag your queue →" link). Cards show `@author`/URL-host,
  caption + reel/post badge, a link-out to open the reel in Instagram (or "needs review" for
  unparsed items), chips/new-tag input, an importance toggle, and dismiss-with-undo.

**Delivered (verified):** `tsc` clean, **62** tests across **14** files green (51 prior + 11 new:
db v3 index, 6 pending-store transitions, 4 worker upsert), clean production build emitting
`tag.html` + the `tag` bundle and `/sw.js` at the dist root. Built TDD (failing test → minimal
impl → green → commit) per task. `tag-view.ts` has no unit test by design (touches `document` at
module load; vitest env is node) — covered by `tsc` + build + a `docs/manual-verification.md`
checklist. Caught during build that three test fakes implement `PendingStore` (sync, promote,
capture) and updated all to the widened interface.

**Still manual / open:**
- On-device acceptance (queue lists pending items, chip/new-tag/importance taps, dismiss+undo,
  offline-tag drains to D1, D1 columns populated) tracked in `docs/manual-verification.md`.
- Existing remote D1 needs `ALTER TABLE` for the five new columns (documented); fresh DBs get them
  from `schema.sql`.
- Sync is still **push-only** — no D1 read-back path, so cross-device pull is out of scope for v1.
- Deferred (model-ready, UI not built): multi-tag per item, frequency-ordered chips, importance
  post-tag editing.

**Artifacts:** spec `docs/superpowers/specs/2026-06-17-prd03-tag-queue-design.md`,
plan `docs/superpowers/plans/2026-06-17-prd03-tag-queue.md`.

**Next PRDs:** 04 Reminder Engine.

---

## PRD 04a — Reminder Engine Core (headless) — 2026-06-24

**What it is:** The first slice of the Reminder Engine — the headless scheduling **brain**. A
Cloudflare Cron Worker that wakes on a schedule, reads D1 for due `tagged` reels, advances them
along an importance-keyed spaced-repetition curve, and assembles a capped, quiet-hours-respecting
digest per user. PRD 04 was much larger than 01–03, so it was decomposed: 04a builds and fully
unit-tests the engine with the push send **stubbed**; 04b adds the delivery skin (Web Push, review
UI, device pull/restore).

**Decisions made:**
- Scope split: 04a = engine + data model + cron, push stubbed behind an injected
  `notify(userId, digest)`. Deferred to 04b: Web Push (VAPID/encryption/subscriptions), review-view
  UI + notification actions, device-side D1 pull/reconciliation, account-based multi-device transfer.
- Identity: device-minted opaque `user_id` (UUID in IndexedDB `meta`), stamped on every write; D1 is
  genuinely multi-user; no auth/login. Account-based transfer designed-for but deferred (a `user_id`
  remap/merge later).
- Reminder state is **cron-owned** (sole writer). The device and the cron write **disjoint** column
  sets, so no last-write-wins arbitration is needed; the cron **lazy-initializes** a freshly-tagged
  item (rather than the device seeding it — avoids a clobber on the conflict path).
- Spacing presets (tunable, PRD §10): `matters` 1d/×1.6/8cyc/90d-age, `normal` 3d/×2.0/4cyc/45d-age.
  Ignore back-off threshold 2 / accel ×1.5. Digest cap 5. Cadence gaps often 1d / balanced 2d (default)
  / rarely 4d. Quiet hours 22→08. Cron hourly, emission gated.
- Topic tags do not affect scheduling in v1 (organizational only, per PRD §7).

**How it works:**
- Pure modules in `src/reminder/`: `spacing.ts` (`initialState`/`advance`, one curve two presets,
  age-out), `response.ts` (`markDone`/`snooze`/`markOpened`/`markIgnored` field patches),
  `digest.ts` (`selectDue` filter+importance-order+cap, `isQuietHours` with midnight-wrap via `Intl`,
  `cadenceGate` with matters pull-forward).
- `worker/cron.ts` `runCron(repo, now, notify)` orchestrates per user: lazy-init → load/create
  settings → pause/quiet/cadence gates → `selectDue` → `advance` each surfaced item (idempotency
  guard `last_surfaced_at < cycleStart`, composed with `markIgnored`) → `notify` → stamp
  `last_digest_at`. Talks to D1 through an injected `ReminderRepo` port.
- `worker/d1-reminder-repo.ts` is the D1 adapter; `worker/index.ts` gains a `scheduled` handler
  (stub `notify` logs the digest) alongside the existing `/api/sync` fetch handler;
  `wrangler.toml` adds `[triggers] crons = ["0 * * * *"]`.
- Data model: `PendingCapture` gains `user_id` + 5 reminder-state fields; new `UserSettings` type +
  D1 `user_settings` table + `idx_due`; IndexedDB **v4** adds `user_settings` + `meta` stores;
  `pending-store` mints/stamps `user_id` and backfills pre-existing records. The device `/api/sync`
  upsert carries `user_id` but never the reminder-state columns (disjointness).

**Delivered (verified):** `tsc` clean, **96** tests across **18** files green (62 prior + 34 new:
spacing 7, response 4, digest 11, cron 7, db v4 1, pending-store identity 2, worker-sync user_id/
disjointness 2), clean production build. Built TDD per task. The D1 repo + `scheduled` handler are
thin adapters verified by `tsc` + build + the manual checklist (same pattern as the existing fetch
handler); all scheduling logic is unit-tested against an in-memory fake repo + capturing `notify`.

**Still manual / open:**
- On-device / `wrangler dev --test-scheduled` acceptance (lazy-init, advance, matters-vs-normal,
  idempotency, pause/quiet-hours, disjoint device sync) tracked in `docs/manual-verification.md`.
- Existing remote D1 needs `ALTER TABLE` for the six new columns + the `user_settings` table /
  `idx_due` (documented).
- 04b: Web Push delivery, review-view UI + done/snooze actions, device D1 pull + reconciliation,
  account-based transfer.
- §10 tuning constants are sane defaults in one place, expected to change with real use.

**Artifacts:** spec `docs/superpowers/specs/2026-06-24-prd04a-reminder-engine-core-design.md`,
plan `docs/superpowers/plans/2026-06-24-prd04a-reminder-engine-core.md`.

**Next PRDs:** 04b Reminder Delivery (Web Push + review UI + device pull).
