# PRD 02b: Backlog Import — Format Correction (Intervention)

**Project:** InSave
**Type:** Correction / intervention amending PRD 02
**Trigger:** A real Instagram saved-posts export (479 entries) was inspected and the actual `saved_posts.json` structure differs significantly from the assumed shape PRD 02 was built against.
**Status:** Active — supersedes the parser-related parts of PRD 02 §2, §6.1, §7, §8.
**Date:** 2026-06-16

---

## 0. Why this document exists

PRD 02 was implemented against an *assumed* `saved_posts.json` structure (flagged in its own notes as "field names are assumption-based"). A real export has now been inspected. The real format is materially different, so the existing parser (`parse-saved-posts.ts`) would fail on real files. This document records the true format, lists the exact required changes, and captures one important, good surprise that improves the product. Treat this as the authoritative description of the export format; where it conflicts with PRD 02, this wins.

## 1. Ground truth: the real `saved_posts.json` format

Verified against a real export of 479 saved items (407 reels, 72 posts). All 479 entries had a timestamp, a URL, and an owner username; 452 had a non-empty caption.

### 1.1 Top level is a bare array (NOT an object)
- **Assumed (wrong):** `{ "saved_saved_media": [ ... ] }`
- **Actual:** the file *is* the array. Top-level JSON is a list of entry objects. There is no `saved_saved_media` wrapper key.
- **Impact:** the current parser looks for a wrapper key, finds nothing, and (correctly, defensively) reports "couldn't read saved posts" on every real file. This is the primary break.

### 1.2 Per-entry shape
Each entry looks like this (reel example, trimmed):

```json
{
  "timestamp": 1781571459,
  "media": [],
  "label_values": [
    {
      "label": "URL",
      "value": "https://www.instagram.com/reel/DZZSfMqu6WY/",
      "href": "https://www.instagram.com/reel/DZZSfMqu6WY/"
    },
    { "label": "Caption", "value": "Problems nobody solved yet, part 3: ..." },
    { "label": "Title", "value": "" },
    { "dict": [], "title": "Hashtags" },
    {
      "title": "Owner",
      "dict": [
        {
          "title": "",
          "dict": [
            { "label": "URL", "value": "https://gotaprob.beehiiv.com" },
            { "label": "Name", "value": "Idea Guy" },
            { "label": "Username", "value": "iamideaguy" }
          ]
        }
      ]
    }
  ],
  "fbid": "18056521565574781"
}
```

Posts (`/p/...`) are structurally identical to reels; only the URL path segment differs.

### 1.3 Field extraction rules (the real paths)
- **Saved timestamp:** top-level `entry.timestamp`. Integer, **in SECONDS**. (PRD 02's seconds→ms conversion is CORRECT and stays.)
- **URL:** inside `entry.label_values`, the item where `label === "URL"`, read its `value` (or `href`, identical). Reels are `/reel/<id>/`, posts are `/p/<id>/`.
- **Caption:** inside `entry.label_values`, the item where `label === "Caption"`, read `value`. May be absent/empty (27 of 479 had none).
- **Author username:** inside `entry.label_values`, the item where `title === "Owner"` → its `dict[0].dict[]` → the item where `label === "Username"`, read `value`. (Also available there: owner `Name` and owner external `URL`, optional extras.)
- **Media type:** infer from the URL path (`/reel/` vs `/p/`). The `media` array was empty in this export; do not rely on it.

## 2. Required changes

### 2.1 Parser rewrite (`parse-saved-posts.ts`) — REQUIRED
- Read the top level as an **array**, not an object. Remove the `saved_saved_media` lookup.
- For each entry, walk `label_values` to extract URL and Caption by matching on `label`, and walk the `Owner` → nested `dict` path to extract Username, per §1.3.
- Keep the seconds→ms timestamp conversion (it's correct).
- Keep all existing defensive behaviour: a structurally unexpected file must still produce a safe, clear error, never a crash or silent import-nothing. Add tolerance for the new shape's variations (missing Caption, missing Owner) by treating those fields as optional, not fatal.
- Backward/forward tolerance: Instagram may still emit the wrapper-object shape for some exports or change again. The parser SHOULD detect "top level is array" vs "top level is object with a known key" and handle both rather than hard-committing to one. Fail safe if neither matches.

### 2.2 Caption is now first-class data — REQUIRED, and a net improvement
- The export **already contains the caption** for nearly every item. This substantially weakens the "thin data" constraint PRD 02 was designed around.
- At parse time, populate the item's enrichment-ish display fields directly from the export: map **Caption → `description`** (and/or `title`), and optionally owner Name. No fetching required.
- **Consequence for the enrichment seam:** for *backlog* items, the risky scrape-vs-oEmbed enrichment decision can stay deferred indefinitely, because the caption comes free from the export. The pluggable `Enricher` stub stays a no-op; the useful text is filled from the export, not from any network call.
- **Scope note:** this only helps backlog items (PRD 02). Live share-captures (PRD 01) still arrive with just a URL, so the enrichment seam still matters there. The risky enrichment question is now isolated to live captures, not the backlog.

### 2.3 Posts vs reels — DECISION NEEDED
- The export contains both reels (407) and regular posts (72). Both are legitimately "saved for later."
- **Recommended:** import both; optionally let the user filter by type in triage. Tag the item with its media type (reel/post) derived from the URL so the UI/PRD 04 can distinguish if desired.
- If the product is to be strictly reels-only, the parser should filter to `/reel/` entries and the doc/UI should say so. (Pending Aarav's call.)

### 2.4 Downstream doc/data touch-ups
- PRD 02 §2 ("the data is thin... no caption") is now partly **false for backlog**: caption is present. Update that framing.
- PRD 02 §8 data model: the nullable `title`/`description` enrichment fields are, for imported items, populated at parse time from the export rather than left null. No schema change (the columns already exist from PRD 02's D1 work); just populate them.
- PRD 03 (Tag Queue) benefit: imported cards can show the real caption text, so the user remembers what a reel was **without** opening Instagram. The "open in Instagram to jog memory" requirement becomes a fallback for imported items rather than the primary path. (Still primary for live captures, which have no caption.)

## 3. What did NOT change (confirmed correct)
- Timestamp handling (seconds → ms) is correct.
- The defensive "fail safe, never crash, never silently import nothing" principle is correct and stays.
- Client-side parsing / privacy model (full archive never leaves device while dormant) is unaffected.
- URL normalization + dedupe reuse from PRD 01 is unaffected (still applied after extraction).
- The pluggable enricher interface was the right call; it just gets to stay a no-op for backlog because the export already carries captions.

## 4. The export's real-world packaging (for the upload UX)
The user's export unzips to:
```
instagram-<user>-<date>-<hash>.zip
  └─ your_instagram_activity/
       └─ saved/
            ├─ saved_posts.json        ← this is the file we parse
            └─ saved_collections.json  ← collections; not used in v1
```
- The PWA's zip handling must locate `your_instagram_activity/saved/saved_posts.json` inside the archive (the path is nested, not at the zip root).
- Instagram offers an option to export **only saved posts as JSON**, which yields `saved_posts.json` directly. The uploader must accept both: the full zip (locate the nested file) and a directly-picked `saved_posts.json`. (This matches PRD 02's existing decision to accept both; just confirm the nested path is handled.)
- `saved_collections.json` exists but is out of scope for v1 (could later map to suggested tags — noted, not built).

## 5. Acceptance criteria for the correction
- [ ] Parser reads a top-level array and extracts URL, Caption, and owner Username via the real `label_values` / `Owner` paths.
- [ ] Parser populates `description`/`title` from the export Caption at parse time (no network).
- [ ] Timestamp still converted seconds→ms; verified against the real range (Dec 2024 → present).
- [ ] Both `/reel/` and `/p/` entries handled per the posts-vs-reels decision.
- [ ] Malformed/unexpected files still fail safe with a clear message.
- [ ] Parser tolerates both the array shape and a possible legacy wrapper-object shape, failing safe if neither.
- [ ] Zip handling locates the nested `your_instagram_activity/saved/saved_posts.json`.
- [ ] Re-run of PRD 02's parser tests updated to the real fixture; all green.

## 6. Open items / decisions
- **Posts vs reels:** import both (recommended) or reels-only? — pending Aarav.
- **`saved_collections.json`:** ignore in v1 (recommended), or mine it for tag suggestions later? — deferred.
- Refresh PRD 02's test fixtures to use a real (anonymised) entry shape so tests reflect reality, not the old assumption.

---

*Amends: PRD 02 Backlog Import. Does not affect: PRD 01 (capture), PRD 03 (tag queue) beyond the noted caption benefit. Does not consume the PRD 04 (Reminder Engine) slot.*
