# Design: PRD02 — Backlog Import

**Project:** InSave
**Source PRD:** `PRD's/02-backlog-import.md`
**Date:** 2026-06-16
**Status:** Approved (pending spec review)
**Builds on:** PRD01 (`url-normalize`, `pending-store`, `sync`, `worker`, D1 `pending_capture`).

## Decisions locked during brainstorming

- **Upload format:** Accept BOTH the full Instagram export `.zip` (unzip client-side with `fflate`, locate `saved_posts.json` inside) AND a directly-picked `saved_posts.json`.
- **Triage UX:** Group by author, sort by recency; per-item keep/skip PLUS bulk "keep all / dismiss all from @author".
- **Storage split:** The full parsed backlog lives only in a new `imported_item` IndexedDB store (dormant items never leave the device). Only on promotion does a `pending_capture` record get created and synced to D1.
- **Enrichment:** Build the swappable `Enricher` interface with a default no-op stub. No real oEmbed/scrape fetcher (explicitly deferred per PRD §7).
- **Promotion model:** A promoted item STAYS in `imported_item` (marked `backlog_state="promoted"`, so the graveyard stays browsable and re-import reconciles) AND a linked `pending_capture` (same `canonical_url`) is created for the Tag Queue + D1.

## 1. Purpose (scope of this build)

Let a user upload their Instagram data export, see their full backlog of saved reels listed instantly with zero requests to Instagram, triage it quickly (grouped by author, with bulk actions), and promote the handful worth keeping into the tracked set. Promoted items conform to PRD01's `pending_capture` shape so the Tag Queue (PRD03) treats all sources uniformly. Dormant items stay local, re-promotable, and never feed reminders or enrichment.

## 2. Architecture

```
import.html (triage page)
  │ user picks export .zip or saved_posts.json
  ▼
zip.ts ──extract──▶ parse-saved-posts.ts ──▶ normalize-import.ts (reuse canonicalize)
  │ (fflate)            ParsedSavedItem[]        ParsedSavedItem → ImportedItem
  ▼
reconcile.ts  ── dedupe within batch + against imported_item store + pending_capture store
  ▼
imported-store.ts  (NEW IndexedDB store `imported_item`, dormant, never synced)
  ▼
triage-view.ts  ── group by author, sort by recency, per-item keep/skip + bulk per-author
  │ user promotes
  ▼
promote.ts ── set backlog_state=promoted → build PendingCapture(source="import", saved_at)
              → enrichment.ts stub (no-op) → pending-store.put → drainSync → D1
```

Everything before promotion is client-only. Promotion reuses PRD01's exact pending-capture + sync path; `drainSync` never sees dormant items because they live in a different object store.

## 3. Data model

### 3.1 New: `ImportedItem` (IndexedDB store `imported_item`)
| field | type | notes |
|---|---|---|
| `id` | string | client-generated UUID |
| `canonical_url` | string | normalized (PRD01 `canonicalize`); dedupe key |
| `author` | string | Instagram username from the export (may be "") |
| `saved_at` | number | original Instagram save timestamp, epoch ms |
| `imported_at` | number | when InSave ingested it, epoch ms |
| `raw_payload` | string | JSON of the raw export entry (recovery/debugging) |
| `parse_ok` | boolean | false if URL couldn't be cleanly extracted |
| `backlog_state` | `"dormant" \| "promoted"` | promotion is the only path into the tracked set |

Index: `by_canonical_url` (non-unique).

### 3.2 Extend `PendingCapture` (PRD01 shared shape)
Add OPTIONAL fields (undefined for share-captures):
- `saved_at?: number` — original save timestamp, preserved for imported items.
- `title?: string`, `thumbnail?: string`, `description?: string` — enrichment fields, the seam for a future real enricher; always undefined under the stub.

### 3.3 Shared DB refactor (`src/db.ts`)
Today `pending-store.ts` opens DB `insave` at version 1 by itself. A second store requires a version bump, and two modules must not open the same DB at different versions. Extract:

```
openInsaveDB(): Promise<IDBPDatabase>   // version 2
  upgrade(db, oldVersion):
    if oldVersion < 1: create "pending_capture" (keyPath id) + index by_canonical_url
    if oldVersion < 2: create "imported_item"  (keyPath id) + index by_canonical_url
```

`pending-store.ts` and `imported-store.ts` both call `openInsaveDB`. `pending-store.ts` keeps its identical public interface (`createPendingStore` → same `PendingStore`), so `capture`/`sync`/`sw` are untouched. The `versionchange` auto-close behavior moves into `openInsaveDB`.

### 3.4 D1 + Worker
Add nullable columns to `pending_capture`: `saved_at INTEGER`, `title TEXT`, `thumbnail TEXT`, `description TEXT`. Worker `INSERT` binds them with `?? null`. Existing capture sync is unaffected (those fields arrive undefined → null). The `idx_canonical_url` partial unique index from PRD01 still applies.

## 4. Components (one responsibility each, testable in isolation)

1. **`src/import/zip.ts`** — `extractSavedPostsJson(file: File): Promise<string>`. If `.zip` (sniff by magic bytes / name), unzip with `fflate` and locate the `saved_posts.json` entry (search by path suffix, the export nests it under `your_instagram_activity/saved/`). If JSON, return its text. Throws `ImportError` if no saved-posts file found.
2. **`src/import/parse-saved-posts.ts`** — `parseSavedPosts(jsonText: string): ParsedSavedItem[]`. Pure, defensive parse of the Instagram structure (top-level `saved_saved_media[]`; each entry `title` = author, `string_map_data["Saved on"].href` = URL, `.timestamp` = epoch seconds → ms; fall back to the first `string_map_data` entry if the "Saved on" key differs). Throws `ImportError` on unparseable/empty/wrong-shape input. Each item: `{ url, author, savedAt }`.
3. **`src/import/normalize-import.ts`** — `toImportedItems(parsed: ParsedSavedItem[], deps): ImportedItem[]`. Maps each via PRD01 `parse`/`canonicalize`, sets `parse_ok`, dedupes within the batch on `canonical_url` (first wins). `deps = { now, uuid }`.
4. **`src/import/imported-store.ts`** — IndexedDB CRUD over `imported_item`: `bulkPut`, `getByCanonicalUrl`, `listAll`, `listByState(state)`, `setState(id, state)`. Uses `openInsaveDB`.
5. **`src/import/reconcile.ts`** — `reconcile(incoming: ImportedItem[], lookup): Promise<ReconcileResult>` where `lookup` exposes `existingImported(canonicalUrl)` and `existingCapture(canonicalUrl)`. Drops items whose `canonical_url` already exists as a promoted/captured `pending_capture` or as an existing `imported_item` (preserving that item's current state). Returns `{ toInsert: ImportedItem[], skippedExisting: number }`. Pure given the injected lookups.
6. **`src/import/enrichment.ts`** — `interface Enricher { enrich(canonicalUrl: string): Promise<EnrichmentResult | null> }`; `EnrichmentResult = { title?; thumbnail?; description? }`; `stubEnricher` returns `null`.
7. **`src/import/promote.ts`** — `promote(item: ImportedItem, deps): Promise<void>`. Sets `imported_item.backlog_state="promoted"`; builds a `PendingCapture` `{ id, canonical_url, raw_payload, captured_at: imported_at, source:"import", status:"pending", parse_ok, synced:false, saved_at }`; runs `enricher.enrich` (stub → null, no fields set); `pendingStore.put`; fire-and-forget `drainSync`. `deps = { importedStore, pendingStore, enricher, drain, uuid }`.
8. **`src/import/triage.ts`** — pure `groupAndSort(items: ImportedItem[]): AuthorGroup[]` (group dormant items by `author`, groups sorted by most-recent `saved_at`, items within a group newest-first). Unit-tested.
9. **`src/import/triage-view.ts`** + **`import.html`** — UI: file picker → run pipeline → render `groupAndSort` result as author groups with per-item keep/skip and per-group bulk keep/dismiss; show counts ("you saved 12 from @x"); error banner on `ImportError`. DOM wiring verified manually.
10. **`src/types.ts`** — add `ImportedItem`, `ParsedSavedItem`, `EnrichmentResult`, `BacklogState`; extend `PendingCapture` (§3.2).

## 5. Data flow & state rules

- Parse and list happen with ZERO Instagram requests (acceptance criterion).
- Dormant items live only in `imported_item`; `drainSync` (which reads `pending_capture`) never touches them.
- Promotion is the only path into the tracked set; it writes a `pending_capture` (synced to D1) and flips the backlog item to `promoted`. The two are linked by `canonical_url`.
- "Dismiss" leaves an item `dormant` (it is never deleted — the graveyard is browsable/re-promotable).
- Re-import: `reconcile` adds only genuinely new `canonical_url`s; existing promoted stay promoted, existing dormant stay dormant. No duplicates.
- Enrichment only ever runs inside `promote` (on the kept set), never on the full backlog. Under the stub it is a no-op.

## 6. Error handling

| Situation | Behavior |
|---|---|
| Not a zip and not JSON / unreadable | `ImportError` → page banner "We couldn't read your saved posts from this file." |
| Zip present but no `saved_posts.json` inside | `ImportError` with guidance, no crash. |
| JSON parses but wrong/empty structure | `ImportError`; never a silent no-op. |
| Single item missing a usable URL | stored with `parse_ok=false`, flagged for review, not dropped. |
| Re-import of already-known items | reconciled out (skippedExisting count surfaced), states preserved. |

## 7. Testing strategy

### Automated (Vitest + fake-indexeddb)
- **zip:** passthrough JSON; a real in-memory zip built with `fflate.zipSync` containing a nested `saved_posts.json` → extracted; a zip without it → `ImportError`.
- **parse-saved-posts:** realistic `saved_saved_media` structure → correct `{url,author,savedAt}`; the "Saved on" key-variant fallback; malformed/empty/non-object → `ImportError`.
- **normalize-import:** two share-variants of one reel collapse to one `ImportedItem`; `parse_ok=false` when no URL.
- **imported-store:** bulkPut/listByState/setState roundtrip; the v2 upgrade creates `imported_item` while `pending_capture` still works (open both stores in one test).
- **reconcile:** new item inserted; item already a `pending_capture` dropped; existing dormant item preserved (not duplicated, not re-inserted).
- **promote:** writes a `pending_capture` with `source="import"`, `saved_at` set, `synced=false`; flips backlog item to `promoted`; calls `enricher.enrich`; calls `drain`.
- **enrichment:** `stubEnricher.enrich` returns `null`.
- **triage:** `groupAndSort` groups by author, orders groups by most-recent save, items newest-first.

### Manual (`docs/manual-verification.md`)
Upload a real export zip on-device; confirm full list renders with no network calls; bulk keep/dismiss; promoted items appear synced in D1; malformed file shows the safe error.

## 8. Repo additions

```
import.html                      # triage page (Vite input)
src/db.ts                        # shared openInsaveDB (v2)
src/import/
  zip.ts  parse-saved-posts.ts  normalize-import.ts
  imported-store.ts  reconcile.ts  enrichment.ts  promote.ts
  triage.ts  triage-view.ts
tests/import/
  zip.test.ts  parse-saved-posts.test.ts  normalize-import.test.ts
  imported-store.test.ts  reconcile.test.ts  promote.test.ts
  enrichment.test.ts  triage.test.ts
schema.sql                       # + nullable saved_at/title/thumbnail/description
worker/index.ts                  # bind new columns ?? null
src/pending-store.ts             # use openInsaveDB (interface unchanged)
src/types.ts                     # new types + PendingCapture extension
vite.config.ts                   # add import.html input
package.json                     # + fflate dependency
```

## 9. Acceptance criteria mapping (PRD §10)

| PRD criterion | Covered by |
|---|---|
| Upload zip/json, see full backlog, zero IG requests | zip + parse + imported-store + triage-view (no network in pipeline) |
| Extract URL+author+timestamp, normalize, dedupe vs existing | parse-saved-posts + normalize-import + reconcile |
| Malformed file → clear safe error, no crash | `ImportError` + triage-view banner |
| Auto-sort by author/recency, no fabricated categories | `groupAndSort` (author + saved_at only) |
| Promote → Tag Queue, shared shape, source="import" | promote.ts → pending_capture |
| Non-promoted dormant, no reminders, never enriched, re-promotable | imported_item store + state rules |
| Enrichment pluggable, stub default, only promoted eligible | enrichment.ts + promote-only call site |
| Re-import reconciles, no duplicates, preserves states | reconcile.ts |

## 10. Out of scope (deferred)

Live IG sync; helping the user request the export beyond a deep link + instructions; the real enrichment fetch decision (oEmbed vs scrape); tagging UX (PRD03); reminders (PRD04); enriching dormant items (never).
