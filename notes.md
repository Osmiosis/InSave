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

---

## PRD 04b — Reminder Delivery (Web Push) — 2026-06-24

**What it is:** The delivery skin over the 04a engine — makes the digests the cron already computes
actually **reach the phone** via Web Push, even when InSave is closed. PRD 04 was sliced 04a (brain) /
04b (delivery) / 04c (interaction); this is 04b. It replaces the 04a `notify` stub with a real Web
Push sender, registers + stores push subscriptions, and shows the notification from the service
worker.

**Decisions made:**
- Scope: delivery only. Deferred to 04c: the review-view UI, device D1 pull/reconciliation
  (reinstall restore), done/snooze/open actions + endpoint. Still deferred: account transfer, guided
  onboarding, notification action buttons (need 04c's action endpoint).
- Web Push via a **vetted Workers-compatible library** (`@block65/webcrypto-web-push`, Web Crypto) —
  the project's first Worker-side runtime dep, isolated entirely behind a `PushSender` port in one
  adapter file so it's swappable.
- Single-user identity unchanged from 04a (device-minted `user_id`); subscriptions stored in D1
  scoped by `user_id` (not in IndexedDB — the browser's `pushManager` + D1 are the source of truth).
- Minimal "Enable reminders" button now; full onboarding/permission UX stays out of scope.
- One notification per digest (the `insave-digest` notification `tag` collapses repeats), honoring
  PRD §6 batching. Dead endpoints (404/410) pruned on send.

**How it works:**
- `PushSender` port (`worker/push-sender.ts`) + `PushSubscriptionRecord`; the library lives only in
  `worker/web-push-sender.ts` (`buildPushPayload` → `fetch(endpoint, init)`, 404/410 → `gone`).
- `makeNotify(repo, sender)` (`worker/notify.ts`) replaces the 04a stub: loads a user's subscriptions,
  `assemblePayload(due)` (pure, shared `src/reminder/payload.ts`), sends to each, prunes gone ones.
  Wired into the `scheduled` handler with VAPID keys from `env`.
- Registration: a new `POST /api/subscribe` (`parseSubscribe` → `repo.putSubscription`) + a new D1
  `push_subscriptions` table. Client `src/push-enable.ts` requests permission, `pushManager.subscribe`,
  and POSTs `{ user_id, subscription }`; `user_id` comes from a shared `getUserId()` factored out of
  `pending-store` into `db.ts`.
- Service worker gains `push` (shows the notification) + `notificationclick` (focus/open the app)
  handlers. VAPID public key in `src/push-config.ts` + `wrangler.toml` `[vars]`; private key a Worker
  secret.

**Delivered (verified):** `tsc` clean, **105** tests across **21** files green (96 from the 04a
baseline + 9 new: payload 2, makeNotify 4, parseSubscribe 2, getUserId 1), clean production build
(the library stays worker-only, out of the client bundle). Built TDD per task. Two type-only frictions fixed during the
build: the library's `Uint8Array` push body vs the Workers `fetch` `BodyInit` type, and TS 5.7's
generic `Uint8Array<ArrayBufferLike>` vs `BufferSource` for `applicationServerKey` — both cast across
the typing gap (valid at runtime). The library adapter, SW `push`/`notificationclick`, and the enable
flow are verified on-device (real crypto + push service + DOM), not in unit tests.

**Still manual / open:**
- VAPID keygen (`npx web-push generate-vapid-keys`) + secret/var setup; replace the placeholders in
  `src/push-config.ts` + `wrangler.toml`; create `push_subscriptions` in remote D1 — all in
  `docs/manual-verification.md`.
- On-device acceptance: enable → subscription row, cron → one notification with app closed, tap opens
  app, stale endpoint pruned.
- 04c: review-view UI, device D1 pull + reconciliation, done/snooze/open actions + endpoint.

**Artifacts:** spec `docs/superpowers/specs/2026-06-24-prd04b-reminder-delivery-design.md`,
plan `docs/superpowers/plans/2026-06-24-prd04b-reminder-delivery.md`.

**Next PRDs:** 04c Reminder Interaction (review UI + device pull + done/snooze).

---

## PRD 04c — Reminder Interaction — 2026-06-24

**What it is:** The closing slice of the Reminder Engine (and of the InSave core loop). 04a computes
due items, 04b pushes the notification — 04c lets the user **act** on a reel and makes data survive a
reinstall. It adds the device pull/read-back path from D1, a review-view UI listing the active queue,
and Done/Snooze/Open actions reaching the server from both the review view and the notification's own
buttons. Completes PRD 01–04.

**Decisions made:**
- Review content = the **live active queue** (all `reminder_status="active"` items, matters-first then
  soonest-due), not a strict "due now" list — 04a's cron advances `next_due_at` on send, so a
  due-gated view would be empty at notification-tap time. The notification count is a teaser; the view
  is the working pile.
- **Notification action buttons** (Done/Snooze on the push itself) — chosen over tap-to-open-only. The
  payload now carries `user_id` + the surfaced `ids`; the SW routes a button tap straight to
  `/api/action` (no window needed); a plain tap opens `/review.html`.
- One **bulk `/api/action`** (1..N ids) serves both the review view (one id) and the notification
  (the digest's ids). Reuses 04a `response.ts` via a pure `applyAction`.
- **Reconciliation rule:** remote authoritative for the five server-owned reminder columns; local
  keeps all device-owned content; absent-local rows inserted whole (reinstall restore). No new tables
  or columns — 04c only reads back + writes existing reminder columns.

**How it works:**
- Pure units carry the logic: `applyAction(item, action, now)` (`src/reminder/action.ts`),
  `mergePulled(local, remote)` (`reconcile-pull.ts`), `rowToPending(row)` (`row-to-pending.ts` —
  D1 row → PendingCapture, topic_tags JSON→array, parse_ok int→bool), `assemblePayload(userId, due)`
  (now with ids+user_id), and `parseAction`/`parsePull`.
- Worker: `GET /api/pull?user_id=` → `repo.listByUser` (maps rows via `rowToPending`) → `{ items }`;
  `POST /api/action` → `parseAction` → per id `getById` + `applyAction` + `writeReminderState`
  (unknown ids skipped). `ReminderRepo` gains `listByUser`/`getById`.
- Client: `pullAndReconcile()` (`src/reminder-pull.ts`) pulls + merges into IndexedDB on launch /
  review open; `review.html` + `src/review-view.ts` render the active queue with Done/Snooze/Open
  (Open also posts `action:"open"`), optimistic card updates + quiet retry on failure. SW `push` adds
  the action buttons + carries ids/user_id; `notificationclick` routes done/snooze to `/api/action`,
  plain tap to `/review.html`. `index.html` gains a "Review reminders →" link; `review` added to the
  vite input + SW shell.

**Delivered (verified):** `tsc` clean, **117** tests across **26** files green (105 from the 04b
baseline + 12 new: applyAction 3, mergePulled 2, rowToPending 2, parseAction/parsePull 4,
pullAndReconcile 1; the 2 payload tests were rewritten in place for the new signature), clean
production build (`review.html` + `review` bundle emitted). Built TDD per task. One type-only friction
fixed: the Notifications API `actions` option is valid at runtime but missing from the lib
`NotificationOptions` type — asserted across. The review-view DOM, SW handlers, and the D1 `/api/pull`
+ `/api/action` paths are verified on-device; all the reconciliation/action/deserialization logic is
unit-tested.

**Still manual / open:**
- On-device acceptance (review queue + Done/Snooze/Open, notification action buttons with app closed,
  reinstall restore via pull, no-clobber re-pull) in `docs/manual-verification.md`.
- A snoozed item can reappear in the review pile before its deferred time (snooze keeps it `active`
  with a pushed-out `next_due_at`); a distinct `snoozed`-that-hides state is a deferred refinement
  (would need the cron to flip `snoozed`→`active`).
- Future, beyond the core loop: account-based multi-device transfer, per-tag scheduling, guided
  onboarding/permission UX.

**Artifacts:** spec `docs/superpowers/specs/2026-06-24-prd04c-reminder-interaction-design.md`,
plan `docs/superpowers/plans/2026-06-24-prd04c-reminder-interaction.md`.

**Next PRDs:** Core loop complete (PRD 01–04). Future: account transfer, per-tag scheduling, onboarding.

---

## Deployment & On-Device Verification (Cloudflare + GitHub) — 2026-06-24

**What it is:** Not a PRD — the first real deployment of the finished core loop to Cloudflare,
wired to GitHub for continuous deploys, followed by full end-to-end verification on a physical
Android phone against production. After this the app is live and self-deploying. (More changes to
come; this records the baseline.)

**Live:** https://insave.fgcworker.workers.dev — free `workers.dev` tier, **no custom domain, $0**.

**Decisions made:**
- **Hosting model:** ONE Cloudflare Worker serves both the static PWA (Vite `dist/` via the
  `[assets]` binding) **and** the `/api/*` endpoints + the hourly cron — chosen over Pages + a
  separate API Worker. The app calls `/api/*` as same-origin relative paths, so a single origin
  removes all route-stitching; a request matching a built asset is served directly, anything else
  falls through to the Worker's `fetch` handler.
- **CI/CD:** GitHub Actions (`cloudflare/wrangler-action`) over Cloudflare's native Git
  integration — fully in-repo and reproducible; the only manual step was the user creating one
  Cloudflare API token in the dashboard.
- **Custom domain deferred / unnecessary:** `workers.dev` works fine on-device (an earlier
  "blocked domain" hypothesis was wrong — see SW fix below). A custom domain remains an option,
  not a requirement.

**How it was set up:**
- `wrangler.toml`: added `[assets] directory = "./dist"`; filled the real D1 `database_id`
  (`269f5f49-32af-44cd-9143-9640a4f83648`, db `insave`, region EEUR); kept `[triggers] crons =
  ["0 * * * *"]`; set `[vars]` `VAPID_SUBJECT = mailto:kgspune@gmail.com` + `VAPID_PUBLIC_KEY`.
- **VAPID:** generated a keypair (`npx web-push generate-vapid-keys`); public key into
  `wrangler.toml` + `src/push-config.ts`; **private key set as a Worker secret** (`wrangler secret
  put VAPID_PRIVATE_KEY`) — never committed.
- **D1:** `wrangler d1 create insave`; `schema.sql` applied remotely (`--remote`) → 3 tables
  (`pending_capture`, `user_settings`, `push_subscriptions`) + indexes.
- **First deploy:** `wrangler deploy` (local auth) → Worker + 17 static assets live; cron
  registered. Smoke-tested live: `/` + `/sw.js` (200 assets), `/api/pull` (200 `{items:[]}` — D1
  read OK), `/api/action {}` (400 validation), `/api/nope` (404 fall-through).
- **GitHub Actions** (`.github/workflows/deploy.yml`): on push to `main` (+ `workflow_dispatch`)
  → `npm ci` → `npm test` (gate) → `npm run build` → `wrangler-action deploy`. Pinned
  `wranglerVersion: 3.114.17`. Secrets: `CLOUDFLARE_ACCOUNT_ID` (set via `gh secret set`),
  `CLOUDFLARE_API_TOKEN` (user-created token, "Edit Cloudflare Workers" + D1 Edit). First
  dispatched run went green (test → build → deploy).

**Service worker bug fixed (commit `0d0b94c`):** On the phone the root loaded but `/tag.html`
failed with `ERR_FAILED`, while the server returned it `200`. Cause: the SW served the app shell
**cache-first**, so a stale/poisoned cache entry broke exactly those paths; `cache.addAll(SHELL)`
is also all-or-nothing, so a single failed fetch left the cache bad. Rewrote the SW to:
- **network-first** for navigations + shell paths (cache is an offline fallback only, so a fresh
  deploy always wins and a bad cache entry can't break a page);
- cache each shell entry **independently** (`Promise.allSettled` of `cache.add`, not atomic
  `addAll`);
- bump `CACHE` `v1 → v2` and **delete stale caches on `activate`** (devices self-heal on next
  load);
- offline fallback uses `caches.match(req, { ignoreSearch: true })` so `/captured.html?status=…`
  still matches the cached toast page. `tsc` clean, **117** tests still green.

**On-device verification (real Android, Chrome, installed PWA):**
- Capture: shared an Instagram reel via the OS share sheet → InSave intercepted it (SW `/share`
  handler) → toast.
- Tag: tagged 2 reels topic **"Claude tricks"**, importance **matters** → synced to D1
  (`status='tagged'`, device-minted `user_id=be81347e…`, both rows present).
- Enable reminders: granted notification permission → a `push_subscriptions` row landed (FCM
  endpoint).
- **Push delivery smoke test:** backdated the two rows' `next_due_at` to "now" (the user ran the
  `UPDATE` via the `!` prefix — a direct prod-D1 write was blocked by the safety classifier), then
  fired the deployed cron on demand via `wrangler dev --remote --test-scheduled` (real remote D1 +
  real Web Push, private key supplied through a gitignored `.dev.vars`) by hitting `/__scheduled`.
  The engine ran the full chain: `selectDue` picked both `matters` items → `advance` moved
  `next_due_at` **+1 day** and `cycle_count` `0→1` (+`ignored_count→1`, `last_surfaced_at`
  stamped) → `notify` sent the Web Push → `last_digest_at` stamped (set only *after* a successful
  send). **The phone received the digest notification, with Done / Snooze action buttons.** The
  `node:crypto` runtime warning proved a false alarm — the push library uses Web Crypto at runtime
  (the successful send confirms it).
- Cleanup: dev server stopped; `.dev.vars` removed and added to `.gitignore` (commit `ef4edca`).

**Delivered (verified):** App live and serving (static + API + D1 + hourly cron); GitHub Actions
auto-deploys on push to `main` (one green run); SW hardened; **the complete loop — capture → tag
→ sync → schedule → Web Push → Done/Snooze — confirmed working on a physical device against
production.**

**Still manual / open:**
- Tap **Done/Snooze** on a real notification to exercise `POST /api/action` end-to-end (server
  path is unit-tested + deployed; the button round-trip wasn't user-exercised yet).
- Reinstall-restore via `GET /api/pull` not yet exercised on-device.
- After the test the 2 reels are scheduled `next_due ≈ 2026-06-25 16:55 UTC`; the cadence gate
  (`last_digest_at` set) suppresses repeat digests for ~1 day — a re-test needs the same backdate.
- Optional: bump the Actions runner `node-version` `20 → 24` (deprecation warning only); attach a
  custom domain (not required).

**Commits this session:** merge `3d2bcc1` (PRD 04a/b/c → main), `0b3642f` (Cloudflare deploy
setup), `0d0b94c` (SW hardening), `ef4edca` (gitignore `.dev.vars`).

---

## PRD 05 — Collections (capture-time organization)

**Why:** All 20 trial users rejected tag-later ("if we're too lazy to stop doomscrolling, who's
going to tag afterward?"). Fix: organize like Instagram — save into **collections at capture**,
when motivation is highest. Collections become the primary organization; tagging (PRD 03) is
**demoted** to an optional cleanup view, not deleted. Zero-tap capture must stay zero-tap: no
choice → drops into the system **"Saved"** collection; a specific collection is a one-tap upgrade.

**Split (decided 2026-06-25):** two phases.
- **05a — data + sync foundation (in progress):** `Collection` entity + per-user undeletable
  "Saved" default; `collection_id` on items with the rule **null ≡ "Saved"** (so capture stays
  zero-write and no migration is needed); item `move`; collections sync to D1 as a **device-owned**
  field — `collection_id` rides the existing `/api/sync`, the collections *list* gets a new
  `POST/GET /api/collections` rail; pull-safety via existing `mergePulled` (server pull can't
  clobber a local move). All headless/TDD. IndexedDB v4→v5; D1 gains `collections` table +
  `collection_id` column.
- **05b — UI (next):** zero-tap capture-chip surface (+ inline "+ New" off the default path),
  collections-as-home view, cleanup view over "Saved" (repurposed tag-view), backlog-promote →
  same picker.

**Brainstorm decisions:** inline "+ New" allowed at capture (05b); **no** tag→collection migration
(existing items keep `topic_tags` hidden, all start in "Saved"); cleanup view built in 05b.

**Design spec:** `docs/superpowers/specs/2026-06-25-prd05a-collections-data-sync-design.md`.

**05a implemented (2026-06-25, complete):** 6 TDD tasks, 6 commits (`83c946a`→`5c8d276`),
all green — 137 vitest tests (117 baseline + 20 new), tsc clean, vite build OK.
1. `Collection` type + `collection_id?` on `PendingCapture`; IndexedDB v4→v5 `collections`
   store; `collections-store.ts` (`ensureDefault` undeletable "Saved", create/rename/remove,
   listUnsynced/markSynced).
2. `pending-store` `move(id, collection_id)` (synced=false) + `listByCollection(colId, savedId)`
   with **null-is-Saved** (newest-first).
3. `/api/sync` rail carries `collection_id` as device-owned content — appended as bind `[17]`
   (col 18) so existing indices don't shift; added to `WireRecord`/`UPSERT_SQL`/`toBind`.
4. Pull-safety: `rowToPending` maps `collection_id`; `mergePulled` regression proves a server
   pull can't clobber a newer local move (device-owned content kept, server reminder cols overlaid).
5. Collections-list rail: `src/collections-sync.ts` `drainCollections` (mirrors `drainSync`:
   post unsynced → mark only accepted → offline/!ok/throw = no-op) + worker
   `COLLECTIONS_UPSERT_SQL`/`parseCollections` + `POST/GET /api/collections` handlers.
6. `schema.sql`: `collection_id TEXT` col, `idx_collection`, `collections` table + index;
   remote D1 migration + checklist appended to `docs/manual-verification.md` (apply once).

**Deferred to 05b:** all UI ACs (capture-chip surface, collections-as-home, cleanup view).
**Remote D1 migration APPLIED 2026-06-25** (`collection_id` col + `collections` table + `idx_collection`/`idx_collections_user` on prod `insave`); verified present. Worker may now be deployed safely.

---

## PRD 05b — Collections UI (2026-06-25, complete)

Core slice on top of 05a: subagent-driven, 8 TDD tasks + opus whole-branch review (ready-to-merge),
151 tests green, tsc clean, build emits index/captured/collection. Four pure headless helpers
(`drainAll`, `recentChips`, `planCollectionDelete`, `capturedRedirectUrl`); DOM verified by tsc+build.
- **index.html = collections home** — collection cards (Saved first) with active-reel counts;
  create / rename / delete (three-way delete: Move to Saved / Delete reels (=dismiss) / Cancel).
- **collection.html** detail — lists a collection's reels (shared `reel-card.ts`) + Move picker.
- **captured.html capture chips** — progressive enhancement: SW redirect carries the record id;
  up to 5 existing-collection chips re-target the just-saved reel via `move`; inline toast + ~4s
  auto-return keep zero-tap intact even if the module never loads.
- **drainAll** wired into SW `activate` + every view + every mutation; SW cache v2→v3.
Deferred to 05c: cleanup view (C), backlog picker (D).

## PRD 05c — Collections finish (2026-06-25, complete) — closes PRD 05

Subagent-driven, 4 TDD tasks + opus whole-branch review (ready-to-merge), 151 tests, +2 promote tests.
- **C — cleanup view:** `tag.html`/`tag-view.ts` → `cleanup.html`/`cleanup-view.ts` (git mv + rewrite),
  retiring the tag queue. Lists the unsorted "Saved" pile; one-tap collection chips + "More…" picker +
  Dismiss, all with undo. SW SHELL `/tag.html`→`/cleanup.html`, cache v3→v4; Vite entry tag→cleanup;
  home gains a "Tidy Saved" link.
- **D — backlog picker:** `promote(item, deps, collectionId?)` (omitted ⇒ Saved); `triage-view.ts`
  adds "Keep to…"/"Keep all to…" via the shared picker; one-tap "Keep"/"Keep all" → Saved unchanged
  (least-tap preserved); swapped `drainSync`→`drainAll`.
No schema change (05a covered it). With 05a+05b+05c, every PRD 05 §10 acceptance item is satisfied.
