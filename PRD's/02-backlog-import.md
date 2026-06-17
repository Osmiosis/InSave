# PRD 02: Backlog Import

**Project:** InSave
**Component:** One-time backlog import from the Instagram data export
**Platform target (v1):** Android PWA, hosted on Cloudflare (Vite + TS, Cloudflare Pages + Worker, D1 + IndexedDB)
**Status:** Draft

---

## 1. Purpose

Let a user pull their existing pile of saved Instagram reels into InSave, the stuff already buried in their Saved folder, so the product is useful on day one instead of starting empty. This is the differentiator: most "save it for later" tools start cold and only capture new things. InSave can resurrect the backlog.

The import is deliberately framed not as "import 300 reminders" but as **"here is your graveyard, resurrect the few worth saving."** The user triages a large messy list and promotes the handful that actually matter into the tracked set. Everything they don't promote stays dormant and never generates reminders.

## 2. Background and constraints

- **Source of truth is the Instagram data export, not an API.** There is no API that exposes saved posts/reels. Instagram's official "Download Your Information" export includes a `saved_posts.json` file listing saved items. The user requests this export, downloads the ZIP, and uploads it to InSave. This path is fully ToS-compliant: the user owns and is given their own data.
- **It is a one-time snapshot, not a sync.** The export reflects saves at export time. New saves after that do not appear. Ongoing capture is handled by PRD 01 (share target). The user can re-import later to refresh, but import is never a live connection.
- **The data is thin.** `saved_posts.json` gives essentially: the saved post's permalink (URL), the author's username, and a timestamp. There is no caption, no thumbnail, no video, no category. This thinness shapes the entire design: the offline first-pass sort can only use author + timestamp, and anything richer requires enrichment (see §7).
- **The export is slow and fiddly to obtain.** Instagram can take up to ~30 days to prepare the export (often faster), and the download link is only valid for a few days. InSave cannot make this instant. The product must set expectations and treat import as an asynchronous, user-initiated chore, not a smooth "Connect Instagram" button.
- **Format drift risk.** Instagram changes its export structure periodically. The parser must be defensive and fail loudly-but-safely (tell the user "couldn't read this file" rather than silently importing nothing or crashing).

## 3. Goals

1. A user can upload their Instagram export ZIP and see their entire backlog of saved reels listed, fast, with **zero** requests made to Instagram during this step.
2. The backlog is **lightly auto-sorted** to make triage easy (sensible grouping/ordering), without pretending to know categories the data can't support.
3. The user can quickly **triage**: skim the list and **promote** the items worth keeping. Promotion is the only thing that moves an item into the tracked/remind-able set.
4. Promoted items conform to the **same record shape** as captured items (PRD 01) so the Tag Queue (PRD 03) treats all sources uniformly.
5. Non-promoted items stay dormant: searchable/re-promotable later, but never feeding reminders.
6. Enrichment of promoted items is a **pluggable, stubbed step** so the import flow is fully functional without it and the risky fetch decision is deferred.

## 4. Non-goals

- Live sync with Instagram. (Impossible; explicitly one-time.)
- Enriching every imported item. (Only promoted items are ever candidates for enrichment, and even that is stubbed by default.)
- Deciding the real enrichment fetch mechanism (oEmbed vs scrape). (Deferred, see §7.)
- Tagging UX itself. (PRD 03 owns tagging; import hands promoted items into that flow.)
- Reminder scheduling. (PRD 04.)
- Helping the user *request* the export from Instagram beyond a deep link + clear instructions. (We can't automate Instagram's side.)

## 5. User flow

### 5.1 Obtaining the export (guided, but user-driven)
1. InSave shows a short, clear walkthrough: how to request the data export from Instagram (Settings → Accounts Centre → Your information and permissions → Download your information), with a deep link to that page where possible.
2. InSave sets expectations honestly: "Instagram prepares this and emails you. It can take anything from a few minutes to a day or so. Come back and upload the ZIP when it arrives."
3. This step is asynchronous and out of InSave's control. The UI should let the user leave and return later without losing their place.

### 5.2 Upload and parse
1. User uploads the export ZIP (or the extracted `saved_posts.json`).
2. InSave parses `saved_posts.json` entirely **locally / on the client** where feasible (no upload of the user's full Instagram archive to a server is required to read saved posts). At minimum, the parse extracts per item: permalink URL, author username, saved timestamp.
3. If the file can't be read (wrong file, unexpected structure, empty), InSave fails safe: a clear message ("We couldn't read your saved posts from this file") and guidance, never a silent no-op or crash.
4. Parsed items are normalized to the canonical URL form (same normalization as PRD 01) and de-duplicated against each other AND against anything already in InSave (so re-importing, or importing something already captured, doesn't create duplicates).

### 5.3 The triage view (the heart of this PRD)
1. The full backlog is shown immediately, with **no Instagram requests made**. Cards show only what the export gives for free: author handle, saved date, and the link.
2. Items are **lightly auto-sorted** to make skimming easy (see §6.2). The point is to reduce the effort of finding the worthwhile ones in a long list, not to guess categories.
3. The user skims and **promotes** items worth keeping (a single clear action per item, e.g. a "keep" tap). Triage must be fast: this list may be large (200+), and the realistic keep ratio is small (often 15–30 items).
4. Promotion is the only path into the tracked set. Un-promoted items remain in a dormant "imported, not kept" state.
5. Promoting an item routes it into the Tag Queue (PRD 03) as a pending-to-tag item, conforming to the shared record shape, with `source = "import"`.

### 5.4 After triage
- Promoted items appear in the Tag Queue alongside share-captured items; the user tags them there (PRD 03).
- Dormant items remain stored and re-promotable later (the graveyard is browsable, not discarded), but generate no reminders and are never enriched.

## 6. Functional requirements

### 6.1 Parsing
- MUST parse `saved_posts.json` from a standard Instagram export, extracting per item at least: permalink URL, author username, saved timestamp.
- MUST be defensive about structure: handle the known export shape, and degrade gracefully (clear error, no crash) if the structure differs or fields are missing.
- MUST normalize URLs to the same canonical form used in PRD 01, and de-duplicate within the import and against existing InSave records.
- SHOULD do parsing client-side where feasible so the user's broader Instagram archive never needs to be uploaded to a server.

### 6.2 Light auto-sort (make triage easy, do not over-guess)
- The triage list MUST be ordered/grouped to make skimming a long list easy. Recommended default: **group by author** and/or **sort by saved date** (most recent first), since repeated saves from the same creator are a strong, cheap signal of what the user cares about, and recency helps memory.
- The sort MAY surface obvious clusters (e.g. "you saved 12 reels from @thiscreator") to help the user keep or skip in bulk.
- The sort MUST NOT fabricate categories it cannot infer from author + timestamp. No fake "this looks like a recipe" guesses from data that doesn't support it. A wrong confident guess is more annoying than an honest "uncategorized." Category assignment is the user's job, done in the Tag Queue after promotion.
- Triage UX MUST be low-effort: skim, keep/skip per item, ideally with bulk actions (keep all from an author, dismiss the rest). Optimize for getting through a 200+ list quickly.

### 6.3 Promotion and record shape
- Promoting an item MUST create/transition it to the **same record shape** consumed by PRD 01 and PRD 03, so the Tag Queue handles imported and captured items identically. Differences are carried only in metadata (`source = "import"`, original saved timestamp preserved).
- Promoted items enter the Tag Queue as pending-to-tag.
- Non-promoted items MUST be stored in a dormant state: retained, re-promotable, excluded from reminders and enrichment.

### 6.4 Dormant backlog handling
- Dormant imported items MUST NOT generate reminders (PRD 04 only ever sees promoted/tagged items).
- The dormant backlog SHOULD remain browsable/searchable so the user can resurrect more later without re-importing.
- A re-import MUST reconcile against existing records (no duplicates; previously dormant items stay dormant unless re-promoted; previously promoted items stay promoted).

## 7. Enrichment (pluggable, stubbed by default — the deferred-risk seam)

Enrichment is the one genuinely unresolved risk in InSave, and this PRD intentionally does **not** resolve it. There is no sanctioned endpoint to fetch a reel's caption/thumbnail from its URL: oEmbed is heavily limited and may return little or nothing, and scraping is fragile and ToS-violating. That decision should be made later, with real promoted reels to test against, not committed to in this spec.

Therefore:

- Enrichment MUST be implemented as a **clean, swappable interface**. The contract: input is a promoted item's canonical URL; output is an optional set of display fields (e.g. title, thumbnail, short description) or nothing.
- The **default implementation is a stub** that returns "no enrichment available." With the stub, a promoted item is still fully functional: it shows author, saved date, link, and whatever tag the user gives it in PRD 03. The plainer card is acceptable; the item is real and remind-able.
- Enrichment, when present, MUST only ever run on **promoted items** (the small set the user kept), never on the full backlog. This keeps request volume low (tens, not hundreds) and tied to genuine user intent, which is the only version of fetching that is even arguably survivable.
- Swapping the stub for a real fetcher (try oEmbed first as lowest-risk; scrape only if explicitly chosen later) MUST require changing only the enrichment module, nothing else in the import or tag-queue flow. If a real fetcher breaks (Instagram changes something), reverting to the stub MUST leave the rest of the product intact.
- The risk and ToS posture of any real fetcher is a **deferred, explicit decision**, flagged here so it is made deliberately and not by accident.

## 8. Data model (additions / reuse)

Imported items conform to the shared record shape (see PRD 01's `pending_capture`), with import-specific metadata:
- `source` = "import"
- `saved_at` — original Instagram save timestamp from the export (distinct from InSave import time)
- `imported_at` — when InSave ingested it
- `backlog_state` — "dormant" | "promoted"
- `canonical_url`, `raw_payload` (the raw export entry), `parse_ok` — as in PRD 01
- enrichment fields (title/thumbnail/description) — nullable, populated only if/when a real enrichment implementation runs on a promoted item

Promotion sets `backlog_state = "promoted"` and routes the item into the Tag Queue (PRD 03) as pending-to-tag, identical in shape to a share-captured pending item.

## 9. Technical notes

- Parsing client-side (in the PWA) avoids shipping the user's whole Instagram archive to a server and keeps the privacy story clean. Only the extracted saved-reel records (and only promoted ones, really) need to reach D1.
- Reuse PRD 01's URL normalization and dedupe logic verbatim; do not fork it.
- Keep the enrichment module behind a single interface from day one even though it's a stub, so the seam exists before it's needed.
- Expect to iterate the parser when Instagram changes the export format; isolate the format-specific parsing so a format change is a localized fix.

## 10. Acceptance criteria

- [ ] User can upload an Instagram export ZIP/`saved_posts.json` and see their full backlog listed, with zero requests made to Instagram during parse/list.
- [ ] Parser extracts URL + author + timestamp per saved item and normalizes/dedupes against existing InSave records.
- [ ] A malformed/unexpected file produces a clear, safe error, never a crash or silent no-op.
- [ ] Backlog is auto-sorted (by author and/or recency) to make triage of a long list easy, with no fabricated category guesses.
- [ ] User can quickly promote items; promotion routes them into the Tag Queue in the shared record shape with `source = "import"`.
- [ ] Non-promoted items are stored dormant, generate no reminders, are never enriched, and remain re-promotable.
- [ ] Enrichment exists as a pluggable interface with a default stub; promoted items are fully functional with the stub; only promoted items are ever eligible for enrichment.
- [ ] Re-import reconciles without creating duplicates and preserves existing promoted/dormant states.

## 11. Open questions

- Exact current structure of `saved_posts.json` (field names, nesting) to be confirmed against a real, recent export during build; parser written defensively regardless.
- Whether import ships in v1 at all, or after the core capture+remind loop is proven. (Import is the differentiator but not part of the minimum useful loop; sequencing is a product call.)
- The real enrichment decision (stub-only, oEmbed, or scrape) is explicitly deferred to when promoted reels can be tested against real responses.
- Bulk-triage affordances (keep-all-from-author, dismiss-rest): exact UX to be validated against a real large backlog.

---

*Prev: 01 Capture + Share Target. Next: 03 Tag Queue, 04 Reminder Engine.*
