# PRD 03 — Tag Queue — Design Spec

**Date:** 2026-06-17
**Project:** InSave
**Source PRD:** `PRD's/03-tag-queue.md`
**Depends on:** PRD 01 (capture/sync), PRD 02 (backlog import), PRD 02b (parser correction — supplies imported author + caption)
**Status:** Locked (implemented)

---

## 1. Purpose

A calm, deliberate place to process captured + promoted reels: assign a reusable topic tag and
an optional one-time importance mark, turning `pending` items into `tagged` tracked items that the
reminder engine (PRD 04) reads. Tagging is intentional and separate from capture — never asked
mid-scroll, never blocking capture.

## 2. Decisions (resolved)

- **Single-tag UI** in v1. Tapping a chip applies it and processes the item immediately (the one-tap
  path). `topic_tags` is a list in the data model, so multi-tag can be enabled later with no migration.
- **Toast undo** for dismissals (reuses PRD 01's toast pattern); no separate dismissed-list view.
- **No item-detail view** in v1. Importance is set once during tagging; the model permits later edits
  but no editing UI ships now.
- **Add columns to `pending_capture` + D1** (one migration): `topic_tags`, `importance`, `tagged_at`,
  plus `author` and `media_type` (deferred here from PRD 02b). Share-captures leave author/media_type
  null; cards fall back to the URL host.
- **Tag set is derived**, not a separate entity: the chip set = distinct `topic_tags` across the user's
  own tagged items (local IndexedDB query). This matches the PRD's "a tag becomes a chip after first
  use" model, needs no second sync path, and persists across sessions locally (backed up via item sync).
- **`topic_tags` stored as a JSON text column** in D1 (e.g. `'["claude tricks"]'`). Flat and dumb per
  PRD §9; PRD 04 reads via JSON parse (or SQLite `json_each` if it ever queries by tag).

## 3. Scope

**In scope:** the Tag Queue page (list `pending` items, tag via chip/new-tag, optional importance,
dismiss with undo), the store transitions and queries that back it, the D1 schema + sync-Worker
changes needed for state transitions to reach the backend, and carrying author/media_type/caption to
the tracked set.

**Out of scope:** reminder scheduling/notifications (PRD 04); enrichment/network fetching (still a
no-op stub; isolated to live captures); capture (PRD 01) and backlog triage/promotion (PRD 02);
tag management beyond create/apply (no rename/merge/hierarchy); a per-item detail/edit view;
multi-tag UI (data supports it, UI deferred); cross-device pull/read-back (the app is push-only today —
no read path exists, so "sync" here means D1 backup + local cross-session persistence).

## 4. Architecture context (existing app)

- Multi-page Vite app: each page is a `rollupOptions.input` entry in `vite.config.ts`
  (`index.html`, `captured.html`, `import.html`). The service worker (`src/sw.ts`) caches a `SHELL`
  list for offline.
- Local-first: all records live in IndexedDB; `drainSync` pushes unsynced records to the Worker
  `/api/sync`, which upserts into D1. **Sync is push-only** — the client never reads back from D1.
- `pending_capture` is the shared tracked-item record (PRD 01/02); `imported_item` is the dormant
  backlog store (PRD 02).

## 5. Data model changes

### 5.1 `PendingCapture` (src/types.ts)
- `status`: widen `CaptureStatus` to `"pending" | "tagged" | "dismissed"`.
- `topic_tags?: string[]` — applied tags (omitted/`[]` until tagged).
- `importance?: "normal" | "matters"` — defaults to `"normal"` at tag time.
- `tagged_at?: number` — epoch ms, set on transition to `tagged`.
- `author?: string` — imported username (carried at promote); null for share-captures.
- `media_type?: "reel" | "post"` — carried at promote; null for share-captures.
- (`description` already exists; imported caption populates it via PRD 02b.)

### 5.2 IndexedDB (src/db.ts) — bump to v3
- Add a `by_status` index on the `pending_capture` store (for `listByStatus`). The v3 upgrade only
  adds the index; existing records default to `status="pending"` already.

### 5.3 D1 schema (schema.sql) + migration
- `ALTER TABLE pending_capture ADD COLUMN topic_tags TEXT;` (JSON array string, nullable)
- `ADD COLUMN importance TEXT;` (nullable; `'normal'`/`'matters'`)
- `ADD COLUMN tagged_at INTEGER;` (nullable)
- `ADD COLUMN author TEXT;` (nullable)
- `ADD COLUMN media_type TEXT;` (nullable)
- `schema.sql` updated so fresh DBs get the columns; a documented `ALTER TABLE` set covers existing
  remote DBs (same pattern PRD 02 used).

## 6. Sync transition mechanism (core)

State transitions reuse PRD 01's idempotent drain — no parallel sync path:

- A transition (`tag`/`dismiss`/`restore`) updates the local record's fields **and sets
  `synced = false`**. `drainSync` (already triggered on `online` + SW activation; also called
  explicitly after a transition) re-sends it.
- The Worker's insert changes from `ON CONFLICT(id) DO NOTHING` to **`ON CONFLICT(id) DO UPDATE SET`**
  the mutable columns: `status`, `topic_tags`, `importance`, `tagged_at`, and also
  `author`/`media_type`/`description`/`saved_at` (so promote-time data lands too). Immutable
  identity columns (`id`, `canonical_url`, `raw_payload`, `captured_at`, `source`, `parse_ok`) are not
  updated. Re-sending the same tagged state is then an idempotent no-op update; a genuine failure
  leaves `synced=false` and retries.
- The existing canonical_url-unique-conflict fallback (different id, same url → confirm presence via
  SELECT before accepting) is preserved.

## 7. Tag set (derived)

- `listDistinctTags()` returns the deduped union of `topic_tags` across the user's `tagged` items
  (a tag exists only once applied, i.e. once the item is tagged), ordered for display (alphabetical in
  v1; frequency-ordering is a noted later enhancement). This is the chip set.
- First-run (no tags yet): show a few greyed-out **example** chips (e.g. "skincare", "robotics") that
  are clearly non-binding placeholders — they demonstrate the gesture and do not persist as real tags
  unless typed/applied. No hardcoded categories ship.

## 8. Store API additions (src/pending-store.ts)

Extend the `PendingStore` interface (existing methods unchanged):
- `listByStatus(status: CaptureStatus): Promise<PendingCapture[]>` — uses the `by_status` index;
  queue view requests `"pending"`, newest-first by `captured_at`.
- `tag(id, { topic_tags, importance }): Promise<void>` — sets `status="tagged"`, `tagged_at=now`,
  the given tags + importance, `synced=false`. No-op-safe if already tagged (idempotent).
- `dismiss(id): Promise<void>` / `restore(id): Promise<void>` — flip `status` between
  `"dismissed"` and `"pending"`, `synced=false` (undo support).
- `listDistinctTags(): Promise<string[]>` — derived chip set (see §7).

Each mutating method sets `synced=false`; the caller fires `drainSync` (fire-and-forget) after.
Injectable `now`/clock kept consistent with existing code (e.g. `Date.now()` default, overridable in
tests).

## 9. UI / flow (tag.html + src/tag-view.ts)

- New page `tag.html` + entry module `src/tag-view.ts`, added to `vite.config.ts` input and to the SW
  `SHELL`/cache list so the queue opens offline (mutations drain on reconnect). `index.html` gains a
  "Tag your queue →" link.
- **Queue:** renders `listByStatus("pending")`. Empty state: a calm "Nothing to tag" message.
- **Card** shows what InSave actually has:
  - **author** — imported username; share-captures fall back to the canonical URL's host.
  - **caption/description** + a reel/post **badge** when present (imported items).
  - a tappable **link-out** to `canonical_url` (opens the reel in Instagram) — primary memory-jog for
    share-captures (no caption), fallback for imported items. Unparsed items (`parse_ok=false`) show a
    "needs review" affordance instead of a broken link.
- **Tagging controls:**
  - existing-tag **chips** (from `listDistinctTags`) as one-tap buttons; tapping a chip tags the item
    and removes it from the queue (the single-tap path).
  - a **new-tag input**: typing a tag + confirm applies it (and it becomes a chip next session, via
    derivation).
  - an **importance toggle** on the card (default normal; tap to elevate to "matters"). Important items
    cost one extra tap; normal items need none.
- **Dismiss:** a junk/dismiss control → `dismiss(id)` + a brief **toast** offering Undo (`restore(id)`)
  during the window. Dismissed items leave the active queue and never become tracked.
- **Quick succession:** processing one item reveals the next with no modal friction.

## 10. Testing

Node-testable units, TDD (fake-indexeddb where IDB is involved):
- `pending-store`: `listByStatus` filters/orders correctly; `tag` sets status/tagged_at/tags/importance
  and `synced=false`; `dismiss`/`restore` flip status and `synced=false`; `tag` is idempotent;
  `listDistinctTags` returns the deduped union across tagged items (and excludes dismissed).
- Worker (`worker/index.ts`): `DO UPDATE` updates `status`/`topic_tags`/`importance`/`tagged_at` on an
  existing row; re-sending identical state is a no-op; a brand-new record still inserts; the
  canonical_url-conflict fallback still works.
- `db.ts`: v3 upgrade adds the `by_status` index without dropping existing data.
- `promote.ts` (PRD 02b seam): carries `author`/`media_type` onto the `pending_capture` (the 02b
  deferral lands here).
- `tag-view.ts` is DOM glue (top-level `document`, node test env) — verified by `tsc` + build + a
  `docs/manual-verification.md` checklist, consistent with `triage-view.ts`.

## 11. Acceptance criteria (from PRD §10)
- [ ] Queue shows captured + promoted items together, uniformly, only `pending`-state items visible.
- [ ] A typed topic tag becomes a reusable one-tap chip in later sessions (derived from applied tags).
- [ ] No hardcoded categories ship; first-run example chips are clearly non-binding.
- [ ] A typical item (existing chip, default importance) is processed in a single tap.
- [ ] Importance elevates in one optional tap, defaults to normal, is never re-prompted.
- [ ] Tagging → `tagged` (tracked, eligible for PRD 04); dismissing → `dismissed` (excluded) with an undo window.
- [ ] All transitions sync to D1 idempotently (Worker `DO UPDATE`), no duplicate writes, retry on failure.
- [ ] Each card lets the user open the original reel in Instagram to jog memory.
- [ ] `importance` and `topic_tags` are stored as queryable D1 data PRD 04 can read.

## 12. Open / deferred (noted, not built)
- Queue ordering: newest-first default (PRD §11); frequency-ordered chips deferred.
- Multi-tag UI deferred (data model ready).
- Importance post-tagging edit deferred (model ready, no UI).
- Cross-device sync requires a D1 read/pull path that doesn't exist yet — out of scope for v1.
