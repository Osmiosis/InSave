# PRD 02b — Backlog Import Format Correction — Design Spec

**Date:** 2026-06-17
**Project:** InSave
**Type:** Correction / intervention amending PRD 02 (parser + import data only)
**Source PRD:** `PRD's/02b-backlog-import-format-correction.md`
**Status:** Approved for planning

---

## 1. Problem

PRD 02's `parse-saved-posts.ts` was built against an *assumed* `saved_posts.json`
shape that never existed in real exports. A real export (479 entries: 407 reels,
72 posts) is a **bare top-level array**, with per-entry data inside a `label_values`
list. The current parser looks for a `saved_saved_media` wrapper object and a
`string_map_data` per-entry map, finds neither, and (correctly, defensively) reports
"couldn't read saved posts" on every real file. Real imports are therefore broken.

The real export also carries the **caption** and the **owner username** for nearly
every item — data PRD 02 assumed absent. This weakens the "thin data" constraint for
backlog items and feeds PRD 03's Tag Queue cards.

## 2. Scope

**In scope (02b):** parser rewrite, the data-model fields needed to carry the new
data through the existing import pipeline (parse → normalize → promote), caption
surfacing into `pending_capture.description`, a small triage-card improvement, and
test/fixture refresh.

**Out of scope (deferred to PRD 03):** adding `author` / `media_type` columns to
`pending_capture` + the D1 schema + the sync Worker. PRD 03 already changes the
schema and Worker (adding `topic_tags`, `importance`, `tagged_at`, and the
pending→tagged/dismissed transitions), so `author` and `media_type` propagation to
the tracked set is batched there to avoid two separate D1 migrations. 02b stays a
pure parser/import-data correction.

**Also out of scope:** network enrichment (the `Enricher` stays a no-op),
`saved_collections.json` (ignored in v1), live-capture caption (PRD 01 captures
still arrive URL-only; the risky enrichment question is now isolated to them).

## 3. Decisions (resolved)

- **Sequencing:** 02b ships before PRD 03; PRD 03 builds on the corrected data.
- **Posts vs reels:** import **both**. Derive `media_type` (`"reel"` | `"post"`)
  from the URL path and store it so triage/PRD 04 can distinguish. Nothing the user
  saved is silently dropped.
- **Caption handling:** map export Caption → `pending_capture.description` at
  promote time (export wins; the `Enricher` stub stays a no-op fallback).
- **Scope split:** `media_type`/`author` live on `ImportedItem` in 02b; their
  propagation to `pending_capture` + D1 is deferred to PRD 03.
- **Triage cards:** include the caption + reel/post badge improvement in 02b.
- **Legacy tolerance:** the old *per-entry* shape (`string_map_data`) was never real
  and is not supported. Tolerance means detecting a **wrapper object around the
  array** (forward-compat if Instagram re-wraps), then applying the real per-entry
  extraction in both cases. Fail safe if neither array nor known-wrapper matches.

## 4. The real format (ground truth)

Top level is an array of entries. Per entry (reel example, trimmed):

```json
{
  "timestamp": 1781571459,
  "media": [],
  "label_values": [
    { "label": "URL", "value": "https://www.instagram.com/reel/DZZSfMqu6WY/", "href": "..." },
    { "label": "Caption", "value": "Problems nobody solved yet, part 3: ..." },
    { "label": "Title", "value": "" },
    { "dict": [], "title": "Hashtags" },
    { "title": "Owner", "dict": [ { "title": "", "dict": [
        { "label": "URL", "value": "https://gotaprob.beehiiv.com" },
        { "label": "Name", "value": "Idea Guy" },
        { "label": "Username", "value": "iamideaguy" }
    ] } ] }
  ],
  "fbid": "18056521565574781"
}
```

Posts (`/p/...`) are structurally identical; only the URL path segment differs.

**Extraction paths:**
- **Saved timestamp:** top-level `entry.timestamp`, integer **seconds** → ×1000.
- **URL:** `label_values` item where `label === "URL"` → `value` (or `href`).
- **Caption:** `label_values` item where `label === "Caption"` → `value` (optional).
- **Author username:** `label_values` item where `title === "Owner"` →
  `dict[0].dict[]` → item where `label === "Username"` → `value` (optional).
- **Media type:** `/reel/` in URL → `"reel"`; otherwise `/p/` → `"post"`.

## 5. Changes by unit

### 5.1 `src/import/parse-saved-posts.ts` (rewrite)
- Parse JSON; on syntax error → `ImportError`.
- **Resolve entry list:** `Array.isArray(data)` → use directly; else if `data` is an
  object with a `saved_saved_media` array → use that; else → `ImportError`.
- For each entry (skip non-objects): walk `label_values` to pull URL, Caption, and
  Owner→Username; read top-level `timestamp`; derive `mediaType` from the URL.
  Missing Caption/Owner are tolerated (fields stay undefined), never fatal.
- Push `{ url, author, savedAt, caption?, mediaType }`. `author` defaults to `""`
  when Owner/Username absent (matches current `ParsedSavedItem.author: string`).
- If zero entries produced → `ImportError`.
- Helpers kept small and local: `findLabel(label_values, label)`,
  `findTitle(label_values, title)`, `ownerUsername(entry)`, `mediaTypeFromUrl(url)`.

### 5.2 `src/types.ts`
- `ParsedSavedItem`: add `caption?: string`, `mediaType: "reel" | "post"`.
- `ImportedItem`: add `caption?: string`, `media_type: "reel" | "post"`.
- (No change to `PendingCapture` in 02b — see §2 deferral.)

### 5.3 `src/import/normalize-import.ts`
- Carry `caption` and `mediaType` from each `ParsedSavedItem` onto the produced
  `ImportedItem` (as `caption`, `media_type`). `raw_payload` continues to serialize
  the full parsed entry, so the new fields are also preserved there.

### 5.4 `src/import/promote.ts`
- Set `description: item.caption` on the built `pending_capture` (only when present).
  The `Enricher` still runs but is a no-op for backlog; the export caption is the
  real source. Order: export caption populates `description`; enricher result, if any
  ever exists, may still spread but must not clobber a present caption.

### 5.5 `src/import/triage-view.ts`
- Render the caption text (when present) and a small `reel`/`post` badge on each
  triage item card, alongside the existing link/keep/skip. Purely additive; the
  existing keep/skip/bulk behaviour is unchanged.

## 6. Error handling
- Malformed / unexpected-shape files → `ImportError` with the existing safe banner
  message; never a crash, never a silent import-nothing.
- Per-entry tolerance: a single bad entry (non-object, missing URL) does not abort
  the batch; it is skipped or flows through as `parse_ok=false` via url-normalize.
- Neither array nor known wrapper object → `ImportError`.

## 7. Testing
- **`parse-saved-posts.test.ts`** — rewrite against a real anonymised **array**
  fixture covering: a reel entry (full), a post entry (`/p/`), an entry with no
  Caption, an entry with no Owner, the wrapper-object fallback shape, invalid JSON →
  `ImportError`, and zero parseable entries → `ImportError`. Assert URL, author
  (username), `savedAt` (seconds→ms), `caption`, `mediaType`.
- **`zip.test.ts`** — update the fixture JSON body to the array shape; the nested
  `your_instagram_activity/saved/saved_posts.json` path test already passes and stays.
- **`normalize-import.test.ts`** — assert `caption`/`media_type` carried onto
  `ImportedItem`.
- **`promote.test.ts`** — assert `description` is set from the imported caption.
- **`triage`** — light assertion that caption/badge render (kept minimal; triage
  rendering is DOM glue).
- Full suite must stay green (`tsc` clean + all vitest files).

## 8. Acceptance criteria (from PRD 02b §5)
- [ ] Parser reads a top-level array and extracts URL, Caption, owner Username via
      the real `label_values` / `Owner` paths.
- [ ] Parser populates `description` from the export Caption at promote time (no network).
- [ ] Timestamp still converted seconds→ms (verified against Dec 2024 → present range).
- [ ] Both `/reel/` and `/p/` entries handled; `media_type` derived and stored on `ImportedItem`.
- [ ] Malformed/unexpected files still fail safe with a clear message.
- [ ] Parser tolerates both the array shape and a wrapper-object shape; fails safe if neither.
- [ ] Zip handling locates the nested `your_instagram_activity/saved/saved_posts.json` (already true; covered by test).
- [ ] Parser/normalize/promote/zip tests updated to the real fixture; all green.
- [ ] Triage cards show caption text + reel/post badge.

## 9. Non-goals / carried forward
- `author` + `media_type` on `pending_capture` / D1 / Worker → **PRD 03**.
- Network enrichment for live captures → still deferred (now isolated to PRD 01 captures).
- `saved_collections.json` → ignored in v1 (possible future tag-suggestion source).
