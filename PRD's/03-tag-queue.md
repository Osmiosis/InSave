# PRD 03: Tag Queue

**Project:** InSave
**Component:** The deliberate tagging session
**Platform target (v1):** Android PWA, hosted on Cloudflare (Vite + TS, Cloudflare Pages + Worker, D1 + IndexedDB)
**Status:** Draft

---

## 1. Purpose

Give the user a calm, deliberate place to process the reels they've captured (via share, PRD 01) and promoted (via backlog import, PRD 02), adding the small amount of meaning that makes good reminders possible: a topic tag, and a one-time importance mark.

This is the deliberate counterpart to capture. Capture is reflexive and fast and happens mid-scroll. Tagging is intentional and happens when the user chooses to sit down with their queue. Keeping these two separate is a core design principle: never ask the user to tag mid-scroll, and never make capture wait on tagging.

## 2. Background and constraints

- The Tag Queue consumes `pending_capture` records produced by **both** PRD 01 (share capture, `source = "share_target"`) and PRD 02 (promoted backlog items, `source = "import"`). It MUST treat both sources identically; the only differences are metadata (source, original `saved_at`).
- Imported items deliberately arrive with **no category guess** (PRD 02 §6.2 forbids fabricated categories). The user assigns meaning here, in the queue. That's by design.
- The data InSave holds per item is thin (URL, author, timestamps, whatever tag the user adds, and possibly stub-level enrichment fields that are usually empty). The tagging UI must be useful with only that. It cannot rely on captions or thumbnails existing.
- Tagging must stay **low-effort**, or people won't do it. The whole queue concept fails if processing an item feels like work. Optimize for "tap, tap, done" per item.

## 3. The tag model (core of this PRD)

Two independent pieces of meaning per item:

### 3.1 Topic tags — user-defined, reusable, no fixed categories
- InSave ships with **no hardcoded categories.** It does not assume the user's life. One person's saves are "claude tricks" and "robotics," another's are "skincare" and "gym," and neither is forced into the other's mental model. This is what makes InSave usable by everyone, not just its author.
- The first time a user needs a tag, they **type it.** From then on, that tag becomes a **one-tap chip** for that user. The second item with the same topic is tagged by tapping the existing chip, not retyping. The user's vocabulary builds itself from their actual saves.
- On first run only, InSave MAY show a few **gentle example tags** purely to demonstrate how tagging works (e.g. greyed-out placeholders). These are examples, not defaults: the user can ignore them entirely and they do not persist as real categories unless chosen.
- An item MAY have more than one topic tag, but the UI should make single-tag the easy default (most items want one). Multi-tag is allowed, not encouraged.

### 3.2 Importance — explicit, one-time, binary
- During tagging, the user gives each item a **one-time importance mark**: a single binary toggle, "this matters" vs the default of normal.
- It is **set once and never re-asked.** Importance is a property of the item that the reminder engine (PRD 04) reads; it is not something the user re-confirms over time.
- It **defaults to normal** and is **optional** (a tap to elevate, not a required step). This keeps the tagging pass fast: the user only spends the importance tap on the items that genuinely stand out. Items they don't elevate are simply normal priority.
- Rationale for binary over a scale: a 1–5 rating is more deliberation than anyone wants in a quick pass, and people cannot meaningfully distinguish adjacent levels. Binary captures the only distinction that matters for reminders: does this deserve to be pushed harder, or just filed.
- This signal is the surviving form of InSave's founding idea (the "important reels, not junk" filter). It gives PRD 04 a real per-item priority from day one, rather than waiting for behavioural history to accumulate.

## 4. Goals

1. The user can process their queue (captured + promoted items) quickly: assign a topic tag and optionally mark importance, with minimal taps per item.
2. Tags are user-defined and become reusable one-tap chips, so tagging gets faster the more the user uses InSave.
3. Both capture sources are handled identically in one unified queue.
4. Tagged items become fully-formed tracked items ready for the reminder engine (PRD 04): they carry topic + importance + timestamps.
5. The user can dismiss/junk an item from the queue without tagging it (capture isn't a commitment to keep).

## 5. Non-goals

- Reminder scheduling or notifications. (PRD 04 reads the tagged items; it doesn't belong here.)
- Enrichment / fetching captions or thumbnails. (PRD 02's stubbed seam; the queue works without it.)
- Capture itself. (PRD 01.)
- Backlog triage/promotion. (PRD 02; promotion *feeds* this queue but is a separate flow.)
- A complex taxonomy/tag-management system (renaming, merging, hierarchies). Keep tags flat and simple in v1; management beyond create/apply/delete is deferred.

## 6. User flow

### 6.1 The queue
1. User opens the Tag Queue (a deliberate action, e.g. opening the app and going to "to tag").
2. They see their pending items, captured reels and promoted backlog items together, ideally newest first or in a sensible processing order.
3. Each item card shows what InSave actually has: author handle, saved/captured date, the link (tappable to open the reel in Instagram if they need to remember what it is), and any enrichment fields if present (usually none).

### 6.2 Tagging an item
1. The user assigns a **topic tag**: tap an existing chip, or type a new one (which then becomes a chip for future use).
2. Optionally, the user taps the **importance toggle** to mark it as mattering. Default is normal; no tap needed for normal items.
3. The item is now tagged and leaves the pending queue, becoming a tracked item visible to PRD 04.
4. The flow should support quick succession: tag one, it's gone, the next is right there. Processing 10 items should feel like a short, satisfying pass, not a chore.

### 6.3 Dismissing junk
1. From the queue, the user can **dismiss** an item without tagging it (it turned out to be junk, or they changed their mind).
2. Dismissed items leave the queue and do not become tracked items / never generate reminders.
3. Dismissal should be reversible enough to avoid accidental loss (e.g. an undo, or a recoverable "dismissed" state), but dismissed items must not clutter the active queue.

### 6.4 Re-opening the reel
- Because InSave often has only a link (no caption/thumbnail), the user may not remember what a given saved reel *was*. The card MUST make it trivial to open the original reel in Instagram to jog memory, then come back and tag. This is the practical workaround for thin data.

## 7. Functional requirements

### 7.1 Unified queue
- The queue MUST present items from both sources (`share_target`, `import`) in a single uniform list, with no behavioural difference based on source.
- Items in `pending` state appear; tagged and dismissed items do not.

### 7.2 Topic tags
- The system MUST let the user create a tag by typing it, and reuse existing tags as one-tap chips thereafter.
- The user's tag set MUST persist (per user) and sync, so chips are available across sessions.
- The system MUST NOT ship hardcoded categories. First-run example tags, if shown, MUST be clearly non-binding examples.
- An item MUST support at least one topic tag; multiple tags MAY be allowed, with single-tag as the easy path.

### 7.3 Importance
- Each item MUST carry an importance value, defaulting to normal.
- The UI MUST let the user elevate an item to "matters" in one tap during tagging, and MUST NOT require it.
- Importance is set during tagging and is not re-prompted over time. (It MAY be editable later via item detail, but is never nagged.)
- The importance value MUST be stored as real, queryable data that PRD 04 reads.

### 7.4 State transitions
- An item moves `pending` → `tagged` when it receives at least a topic tag (importance optional). A `tagged` item is a tracked item, eligible for reminders.
- An item moves `pending` → `dismissed` when junked; dismissed items are excluded from reminders and from the active queue, with a reversible window to undo.
- Transitions MUST sync to D1 idempotently (reuse PRD 01's sync discipline; no duplicate state writes; failures retry).

### 7.5 Low-effort guarantee
- The common path (assign one existing-chip tag, leave importance default) MUST be a single tap to fully process an item.
- The UI MUST support processing items in quick succession without modal friction between items.

## 8. Data model (additions / reuse)

Extends the shared `pending_capture` record (PRD 01/02). Added/used fields:
- `status` — extends to: "pending" | "tagged" | "dismissed" (PRD 01 introduced "pending").
- `topic_tags` — the user's applied tag(s) for this item (references the user's tag set).
- `importance` — value defaulting to normal, elevatable to "matters". Stored as queryable data for PRD 04.
- `tagged_at` — timestamp when the item was tagged (distinct from captured/saved/imported times).
- (existing) `canonical_url`, `author`, `saved_at`, `captured_at`, `source`, `parse_ok`, nullable enrichment fields.

A per-user **tag set** entity:
- the list of tags the user has created, persisted and synced, surfaced as one-tap chips. Flat list in v1 (no hierarchy/merge).

PRD 04 consumes items where `status = "tagged"`, keyed on `importance`, `topic_tags`, and the various timestamps.

## 9. Technical notes

- Reuse PRD 01's IndexedDB-local + D1-synced model and the idempotent drain for all state transitions. Tagging/dismissing are just new transitions on the existing record; do not invent a parallel sync path.
- The tag set is small per-user data; store it alongside the user's records and sync it like everything else.
- Keep tag handling flat and dumb in v1. Resist building tag management (rename/merge/hierarchy) now; it's a deferred enhancement, not part of the core loop.
- Card "open in Instagram" is just a link-out to the canonical URL; no API, no enrichment needed.

## 10. Acceptance criteria

- [ ] The queue shows captured and promoted items together, uniformly, with only `pending`-state items visible.
- [ ] A user can create a topic tag by typing it; it then appears as a reusable one-tap chip in later sessions.
- [ ] No hardcoded categories ship; any first-run example tags are clearly non-binding.
- [ ] Processing a typical item (existing-chip tag, default importance) takes a single tap.
- [ ] A user can elevate importance in one optional tap; importance defaults to normal and is never re-prompted.
- [ ] Tagging moves an item to `tagged` (tracked, eligible for PRD 04); dismissing moves it to `dismissed` (excluded), with an undo window.
- [ ] All transitions sync to D1 idempotently with no duplicate writes and proper retry on failure (reusing PRD 01 discipline).
- [ ] Each card lets the user open the original reel in Instagram to jog memory before tagging.
- [ ] `importance` and `topic_tags` are stored as queryable data that PRD 04 can read.

## 11. Open questions

- Default queue ordering (newest-first vs oldest-first vs grouped): to be felt out in use; newest-first is a reasonable default.
- Whether multi-tag per item is exposed in v1 UI or held back for simplicity (data model supports it either way).
- Exact undo affordance for dismissals (toast-undo vs a recoverable dismissed list).
- Whether importance is editable post-tagging via an item detail view (allowed by the model; UI inclusion is a v1 scope call).
- Whether tagging should offer the user's most-used chips first (frequency-ordered chips) as a later low-effort enhancement.

---

*Prev: 01 Capture + Share Target, 02 Backlog Import. Next: 04 Reminder Engine.*
