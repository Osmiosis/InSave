# PRD 01: Capture + Share Target

**Project:** InSave
**Component:** Reel capture pipeline (the fast path)
**Platform target (v1):** Android PWA, hosted on Cloudflare
**Status:** Draft

---

## 1. Purpose

Let a user save an Instagram reel into InSave in under a second, directly from Instagram's native share sheet, then return to scrolling immediately. Capture must be reflexive and near-invisible. No tagging, no enrichment, no decisions happen at capture time. Those are deferred to a separate, deliberate session (see PRD 03: Tag Queue).

This is the single most important interaction in the product. If capture has any friction, users will not do it, and nothing else in InSave matters.

## 2. Background and constraints

- There is no Instagram API that exposes saved reels or accepts content into them. Capture works by the user actively sharing a reel out of Instagram into InSave.
- On Android, an installed PWA can register itself in the system share sheet via the `share_target` member in its web app manifest. When the user picks InSave from Instagram's share sheet, the OS launches InSave and passes the shared data.
- The PWA **must be installed** (added to home screen) before it appears as a share target. Visiting the site in a browser tab is not enough. Installation is therefore a required onboarding step, handled in onboarding (out of scope for this PRD, but capture depends on it).
- What Instagram passes to the share target is thin: typically a URL and sometimes a title/text string. No caption, no thumbnail, no video. That is acceptable here because capture only needs the link. Enrichment is a separate, on-demand concern (see PRD 02 and PRD 03).
- iOS is explicitly out of scope for v1. The same web codebase will later support iOS by swapping the capture channel for an iOS Shortcut; everything else ports unchanged. Do not build iOS-specific paths now, but do not architect in a way that blocks them later.

## 3. Goals

1. A shared reel is persisted to a durable "pending" queue in well under one second of perceived time.
2. The user is returned to Instagram (or sees an unobtrusive confirmation) without being asked to do anything.
3. Capture succeeds even when the network is briefly unavailable (queue locally, sync when possible).
4. Duplicate captures of the same reel are detected and collapsed, not duplicated.

## 4. Non-goals

- Tagging, categorizing, or rating the reel at capture time. (PRD 03)
- Fetching caption, thumbnail, or any enrichment data. (PRD 02 / PRD 03)
- Backlog import from the Instagram data export. (PRD 02)
- Reminder scheduling or notifications. (PRD 04)
- iOS capture. (deferred v2)
- Onboarding / install prompt UX (assumed already done; capture depends on it).

## 5. User flow (happy path)

1. User is scrolling Instagram, sees a reel worth keeping.
2. User taps Instagram's share button, then taps **InSave** in the share sheet.
3. Android launches InSave's registered share-target endpoint and hands over the shared URL.
4. InSave's handler does the minimum synchronous work: validates and normalizes the URL, writes a pending record, returns immediately.
5. User sees a brief, dismissible confirmation (e.g. a toast: "Saved. Tag it later.") or is bounced straight back. No blocking UI.
6. User returns to scrolling. Total interaction: share button, one tap, done.

## 6. Functional requirements

### 6.1 Share target registration
- The web app manifest MUST include a `share_target` entry so the installed PWA appears in the Android system share sheet.
- The share target SHOULD accept at minimum a URL parameter, plus title/text as available, since Instagram's payload shape is not guaranteed.
- Use a method/encoding appropriate for receiving the payload reliably (e.g. POST with form encoding, or GET with query params). Implementer to confirm against current Instagram share payload behavior on Android during build.

### 6.2 URL handling
- The handler MUST extract the Instagram reel URL from the shared payload. Instagram may share the URL in the `url` field, embedded in the `text` field, or both; the handler MUST check all provided fields and recover the reel URL robustly.
- The handler MUST normalize URLs to a canonical form (strip tracking query params, unify trailing slashes, resolve obvious share-link variants) so that the same reel shared twice produces the same canonical key.
- If no usable Instagram URL can be extracted, the handler MUST fail gracefully: persist whatever was shared as an "unparsed" pending item flagged for user review, rather than silently dropping it. (Losing a save is worse than saving something messy.)

### 6.3 Pending record
- Each capture MUST create a pending record containing at least: canonical URL, raw shared payload (for recovery/debugging), capture timestamp, and source ("share_target").
- A pending record is intentionally minimal. No tag, no category, no enrichment fields populated yet. Those are added later in the tag queue.
- Records are "pending" until the user processes them in the tag queue. Pending is a first-class state, not a temporary buffer.

### 6.4 Speed and perceived performance
- Synchronous work on the capture path MUST be limited to: parse, normalize, dedupe-check, persist, confirm. Anything else (enrichment, network calls to Instagram, reminder scheduling) MUST be deferred or done asynchronously after the user is released.
- Target: pending record durably written and user released in under ~1s on a mid-range Android device on a normal connection.

### 6.5 Offline resilience
- If the device is offline or the backend is unreachable at capture time, the capture MUST still succeed locally (e.g. queued in local storage / IndexedDB / a service worker) and sync to the backend when connectivity returns.
- The user MUST NOT be shown an error that blocks them from returning to Instagram because of a transient network issue. Capture should feel like it always works.

### 6.6 Deduplication
- Before creating a new pending record, the handler MUST check whether the same canonical URL already exists (in pending OR already-tagged state).
- On duplicate: do not create a second record. Surface a gentle confirmation that it's already saved (e.g. "Already in InSave"). Optionally bump a "saved again" signal, which the reminder engine may later treat as an importance hint (see PRD 04, non-binding).

## 7. Data model (minimal, for this component)

A `pending_capture` record (fields, not final schema):
- `id` — internal unique id
- `canonical_url` — normalized Instagram reel URL (dedupe key)
- `raw_payload` — original shared title/text/url as received
- `captured_at` — timestamp
- `source` — "share_target" (future: "import", "shortcut", "clipboard")
- `status` — "pending" (later transitions handled by PRD 03)
- `parse_ok` — boolean; false means the URL couldn't be cleanly extracted and the item needs user review

This record is the contract handed to PRD 03 (Tag Queue) and is the same shape backlog-imported items (PRD 02) will conform to, so the tag queue can treat all sources uniformly.

## 8. Technical notes / suggested stack

- PWA served over HTTPS (required for share target, service worker, install). Cloudflare Pages/Workers fits, consistent with existing InSave infra.
- Service worker handles offline queueing and the share-target POST handler.
- Local store (IndexedDB) for the offline pending queue; sync to backend store (Cloudflare D1 / KV / chosen DB) when online.
- Keep the share-target endpoint logic dumb and fast. Resist the temptation to "just also fetch the thumbnail here." That belongs in PRD 02/03.

## 9. Acceptance criteria

- [ ] Installed PWA appears in Instagram's Android share sheet as "InSave".
- [ ] Sharing a reel creates exactly one pending record with a correctly normalized canonical URL.
- [ ] User is released back to scrolling with no required interaction beyond picking InSave in the share sheet.
- [ ] Sharing the same reel twice does not create a duplicate; user sees an "already saved" confirmation.
- [ ] Capture succeeds while offline and later syncs without user intervention.
- [ ] A share payload with no clean URL is preserved as a `parse_ok = false` pending item, never silently dropped.
- [ ] No enrichment, tagging, or reminder logic runs on the capture path.

## 10. Open questions

- Exact shape of Instagram's Android share payload (which field carries the reel URL) needs to be verified empirically on-device during build; the handler should be defensive about it regardless.
- Confirmation UX: silent bounce-back vs. brief toast. Lean toward the least intrusive option that still reassures the user the save worked. To be validated with real use.
- Whether a repeat-save should feed an importance signal to the reminder engine, decision deferred to PRD 04.

---

*Next PRDs: 02 Backlog Import, 03 Tag Queue, 04 Reminder Engine.*
