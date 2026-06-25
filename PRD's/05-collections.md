# PRD 05: Collections (capture-time organization)

**Project:** InSave
**Component:** User-created collections, chosen at capture, as the primary organizing system
**Platform target:** Android PWA on Cloudflare (single Worker: static + `/api/*` + cron; D1 + IndexedDB), live at the production deployment
**Status:** Draft
**Supersedes:** the *role* of PRD 03 (Tag Queue) — see §3. Does not delete PRD 03's mechanics; demotes them.

---

## 0. Why this PRD exists (the user signal)

20 real users used InSave. All 20 said the same thing about the tag-later step: *"if we're too lazy to stop doomscrolling, who's going to tag after we're done scrolling?"* That is not a feature request; it is them identifying a fatal assumption in the product. The whole premise of InSave is that these are lazy-by-admission people who forget a reel exists. Expecting that same person to run a deliberate tagging session afterward is a contradiction we built in.

The fix, also from the users: organize like Instagram. Let them save into collections **at the moment of capture**, when motivation is highest (they just decided the reel was worth keeping), instead of in a later session that will never happen. This PRD makes collections the primary organization and demotes tagging to optional cleanup.

This is the same insight that made share-capture beat manual-paste, now applied to sorting: move the small decision to the moment of engagement, and never require it.

## 1. The core principle (do not violate)

**The zero-tap capture path must stay zero-tap.** The genius of the current share flow is that it asks nothing and bounces the user back to scrolling in under a second. Collections must not break that. Therefore:

- Saving with **no choice** drops the reel into a default **"Saved"** collection. Zero extra taps. The lazy path is fully preserved.
- Saving into a **specific** collection is an **optional one-tap** upgrade at share time (tap a collection chip).
- This mirrors Instagram's save-to-collection behaviour: default bucket by default, pick a collection if you want.

If collection-picking ever becomes mandatory, we have recreated the exact friction the users complained about, just moved earlier. It must not.

## 2. What collections are

- A **collection** is a user-created, user-named bucket ("Recipes", "Claude tricks", "Gym", "Watch with friends"). The user makes them; InSave ships none hardcoded (same philosophy as tags: don't assume the user's life).
- Every captured/imported item belongs to **exactly one** collection at a time (like Instagram). Default is "Saved". The user can move an item between collections later.
- "Saved" is the **system default collection**, always present, cannot be deleted. It is the inbox for anything captured without an explicit choice.
- Collections are the **primary organization** surface: the app's main view is "your collections", and opening one shows its reels.

## 3. What happens to tagging (PRD 03 demoted, not deleted)

Per the decision: **collections replace tagging as the organizing system.** Concretely:

- The deliberate tag queue is **no longer the mandatory sorting step.** It becomes an **optional cleanup view** over the **"Saved" pile** only: a place to go *if* the user wants to move unsorted items into collections later. It is never required.
- PRD 03's mechanics are **reused, not thrown away**: the chip/move interaction becomes "move this Saved item into a collection." Importance lives on (now a 3-tier scale, see PRD 06). Topic tags as a *separate* concept are **retired from the primary flow** — collections are the organizing label now. (Existing `topic_tags` data is preserved and may surface as a secondary detail, but the product no longer asks users to tag.)
- The "graveyard triage" from backlog import (PRD 02/02b) maps naturally onto collections: promoting a backlog reel can now drop it into a chosen collection, same picker as capture.

Net effect: the user organizes by **saving into collections**, at capture or import. They are never asked to do a separate tagging session. The cleanup view exists for the motivated, not the lazy.

## 4. Goals

1. A user can create and name collections.
2. At capture (share-target), the user can drop a reel into "Saved" with zero extra taps, or into a specific collection with one tap.
3. The app's primary view is the user's collections; opening one lists its reels.
4. Items can be moved between collections after the fact.
5. The "Saved" default is always present, undeletable, and is the home for un-chosen captures.
6. Backlog promotion (PRD 02) can target a collection via the same picker.
7. The zero-tap capture path is provably preserved.

## 5. Non-goals

- **Automatic sorting** of reels into collections by a system/AI. The users explicitly called this "radical, much later." Collections are the *foundation* that makes it possible later (they produce the labelled signal an auto-classifier would train on), but auto-sort is NOT built here. (See §11.)
- Multiple collections per item (one-at-a-time, like Instagram, in v1).
- Collections influencing reminder cadence. In v1 collections are **pure organization**; scheduling is driven by importance + deadline (PRD 06), not by which collection an item is in. (Deferred, same call we made for tags.)
- The dashboard redesign itself (separate, comes after this and PRD 06 so it can display the final shape).
- Sharing/collaborative collections. Single-user in v1.

## 6. User flow

### 6.1 Creating collections
- The user creates a collection by naming it (in the app's collections view, and/or inline at capture via a "+ New collection" affordance).
- Created collections persist per user and sync.

### 6.2 Capture with collections (the critical path)
1. User shares a reel from Instagram → InSave's share-target receives it (PRD 01 flow).
2. The capture landing shows a fast, lightweight surface: the reel is **already being saved to "Saved"** (pre-selected default), plus a row of collection **chips** (most-recent / most-used collections) and a "+ New" option.
3. **Doing nothing** (or the auto-dismiss) commits the reel to "Saved" → user is back to scrolling. **Zero extra taps.**
4. **Tapping a collection chip** commits the reel to that collection instead → back to scrolling. **One tap.**
5. The synchronous capture work (parse, normalize, dedupe, persist) is unchanged from PRD 01 and still runs locally/offline-first; the collection choice is just one more field on the pending record, defaulted to "Saved".

- Performance rule: the picker must not delay the durable save. The reel is persisted to "Saved" immediately; a chip tap updates its collection field. Even if the user taps a chip a beat later, the save already happened. No blocking.
- If the user has many collections, show a bounded set (recent/frequent) plus access to the full list; never render a giant scroll on the capture surface.

### 6.3 Browsing collections (primary app view)
- The app's home is the list of collections (each showing a count, maybe a recent thumbnail/caption). "Saved" is always there.
- Opening a collection lists its reels (caption for backlog items, author, badge, link-out to Instagram).

### 6.4 Moving / cleanup
- From any reel, the user can move it to a different collection.
- The optional **cleanup view** over "Saved" (the demoted tag queue) lets the user batch-move unsorted items into collections. Optional, never forced.

### 6.5 Backlog import → collections
- Promoting a backlog reel (PRD 02) uses the same collection picker; default "Saved" if none chosen.

## 7. Functional requirements

### 7.1 Collection entity
- MUST support user-created, user-named collections, persisted per user and synced to D1.
- MUST provide a system "Saved" collection per user: always present, undeletable, the default target.
- Each item MUST reference exactly one collection (`collection_id`), defaulting to "Saved".

### 7.2 Capture-time selection (preserve zero-tap)
- The capture path MUST persist the reel immediately to "Saved" (default) using PRD 01's offline-first local write; no network and no collection choice are required to complete a save.
- The capture surface MUST offer one-tap assignment to an existing collection (chips) and a "+ New collection" path.
- Committing with no explicit choice MUST result in "Saved". This behaviour MUST be guaranteed (a missing/!skipped choice always resolves to the default, never to an error or a dropped save).
- The collection picker MUST NOT block or delay the durable save.

### 7.3 Collections as primary view
- The app's primary navigation MUST present collections as the main organizing view.
- Each collection view MUST list its items with the existing card info (caption/author/badge/link-out).

### 7.4 Moving items
- The user MUST be able to move an item from one collection to another; the change syncs idempotently (reuse PRD 01/03 sync discipline; `collection_id` is a device-owned content field).

### 7.5 Tag-queue demotion
- The deliberate tag queue MUST no longer be presented as a required step.
- A cleanup view over the "Saved" collection SHOULD exist (optional) reusing the move interaction.
- Existing `topic_tags` data MUST be preserved; the product MUST NOT prompt for tagging as a mandatory action.

### 7.6 Sync & ownership
- `collection_id` (per item) and the collection list are **device-owned content** fields (like tags/importance), distinct from the server-owned reminder-state columns (PRD 04). Pull/reconcile (PRD 04c) MUST treat them as device-owned: a server pull does not clobber a newer local collection assignment.
- Collections list syncs to D1 so it survives and (once account transfer exists) can restore.

## 8. Data model (additions / reuse)

New `collection` entity (per user):
- `id`, `user_id`, `name`, `created_at`, `is_default` (true only for "Saved")

Extend the item record (`pending_capture`):
- `collection_id` — references the item's current collection; defaults to the user's "Saved" collection.

Reuse: all existing capture/import/reminder fields. `topic_tags` retained (no longer prompted). Importance becomes 3-tier per PRD 06.

D1: new `collections` table; `pending_capture` gains `collection_id`. Apply via `schema.sql` (fresh) / `ALTER TABLE` (existing remote), per the established migration pattern in `docs/manual-verification.md`.

## 9. Capture-surface design notes (so zero-tap survives)

- Treat the capture landing as: "Saved ✓" shown as already-done, with collection chips as optional redirects. The visual default state is success, not a prompt.
- Pre-select "Saved"; a chip tap re-targets. Auto-dismiss to "Saved" after a short beat so an inattentive user is never stuck on a picker.
- Bound the chips (recent/frequent). Full-list and new-collection creation are one level deeper, off the hot path.
- This surface replaces / extends PRD 01's `/captured.html` toast: it becomes a slightly richer but still glanceable, auto-dismissing confirmation that happens to offer collection chips.

## 10. Acceptance criteria

- [ ] A user can create and name collections; "Saved" always exists and can't be deleted.
- [ ] Sharing a reel with no choice commits it to "Saved" with zero extra taps and returns to Instagram.
- [ ] Sharing and tapping one collection chip commits it to that collection in one tap.
- [ ] The durable save happens immediately regardless of (or before) the collection choice; capture still works offline.
- [ ] The app's primary view is collections; opening one lists its reels with caption/author/badge/link-out.
- [ ] An item can be moved between collections; the change syncs without clobbering on pull.
- [ ] The tag queue is no longer a required step; an optional cleanup view over "Saved" exists.
- [ ] Backlog promotion can target a collection via the same picker (default "Saved").
- [ ] `collection_id` and the collections list sync to D1 as device-owned fields; reminder-state columns are untouched by collection changes.
- [ ] Existing `topic_tags` data is preserved; no mandatory tagging prompt remains.

## 11. The path to auto-sort (noted, NOT built)

The users' "radical, much later" ask was: a system that sorts reels into collections automatically. This PRD deliberately does not build that, but it lays the groundwork:

- Every time a user saves a reel into a named collection, they produce a **labelled example** (this reel → "Recipes"). Over time this is exactly the training signal an auto-classifier needs.
- Backlog items already carry **captions** (PRD 02b), so there is real text to classify on for imported reels; live captures have the URL/author.
- A future auto-sort feature would *suggest* a collection at capture (which the user accepts/overrides with one tap), never silently move things. Suggestion-with-one-tap-confirm keeps the user in control and keeps generating labels.
- Explicitly deferred. Collections must prove themselves as a manual feature first.

## 12. Open questions

- Capture-surface chip count / ordering (recent vs most-used): tune with real use.
- Whether "+ New collection" at capture is worth the hot-path complexity, or whether new collections are made only in-app (capture only picks existing ones). Lean: pick existing at capture; create in-app. Validate with users.
- Whether the optional cleanup view is worth building in this PRD or deferred until users ask (the demotion of tagging stands either way).
- Long-term: do collections eventually influence reminder cadence (remind harder on some collections)? Deferred; flagged.
- Migration UX for existing tagged items: do their `topic_tags` auto-map to same-named collections on upgrade? Possible nicety; decide at build.

---

*Reshapes: PRD 01 (capture gains an optional collection chip surface), PRD 03 (demoted to optional cleanup). Pairs with: PRD 06 (importance tiers + deadlines). Precedes: dashboard redesign.*
