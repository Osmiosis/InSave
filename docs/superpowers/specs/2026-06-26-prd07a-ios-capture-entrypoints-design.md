# PRD 07a — PWA capture entry points (deep-link + clipboard) (design)

**Project:** InSave
**Parent PRD:** `PRD's/07-iphone-capture-ios-shortcut.md`
**Sibling (next):** PRD 07b — iOS onboarding + platform detection + the iCloud Shortcut artifact + push reliability (needs a real iPhone)
**Parallels:** PRD 01 (Android Web Share Target)
**Status:** Approved design, pre-plan
**Date:** 2026-06-26

---

## 0. Scope

PRD 07 (iPhone capture via an iOS Shortcut) is split, mirroring 05/06:

- **07a (this doc):** two **new entry points into the existing capture pipeline** — a deep-link
  capture page (`GET /capture?u=<reel-url>`, the URL the iOS Shortcut will open) and a clipboard
  fallback. Both reduce to *extract a URL → `handleCapture` → `captured.html`*. No new capture logic,
  no backend change. The one new pure unit is query→payload mapping; everything else is reuse + thin
  DOM glue. **Buildable and headless-testable today, no iPhone required.**
- **07b (next):** iOS/Safari detection + the iOS onboarding screen (Add-to-Home-Screen screenshot,
  Shortcut iCloud link, capture gesture), the **Shortcut artifact** itself, and push reliability
  (§4.5: re-validate subscription on app open + backend marks stale subscriptions). These are
  device-verified / UX-heavy and wait for a real iPhone.

07a is platform-agnostic: the deep-link page and clipboard button work on any browser. They become
*iOS-meaningful* in 07b (the Shortcut targets the deep link; the clipboard path is the zero-setup
fallback), but nothing in 07a is iOS-specific.

## 1. Decisions carried in from brainstorming (2026-06-26)

- **Deep-link is a plain `https://…/capture?u=<url>`** — no custom URL scheme (unreliable for iOS
  PWAs). The Shortcut (07b) opens this https URL; 07a just handles it.
- **Reuse `captured.html`** for the confirmation (existing toast + optional one-tap collection chips,
  zero-tap "Saved" default) rather than an iOS-specific screen — consistent with Android, minimal new
  code (PRD §7 leaned "default to Saved, keep it fast"; `captured.html` already does exactly that).
- **Clipboard read is on an explicit button tap**, never auto-on-load — iOS gates clipboard access to
  a user gesture, and it avoids a surprise permission prompt.
- **Param names:** `u` is primary; `url` and `text` accepted as aliases so the Shortcut artifact can
  be authored loosely. Precedence `u → url → text`.

## 2. Components

### 2.1 `src/share-query.ts` (new, pure, tested)

```ts
import type { SharePayload } from "./types";

// Maps a deep-link query string to a SharePayload for the existing capture
// pipeline. `u` is the canonical param the Shortcut sends; `url`/`text` are
// accepted aliases. extractReelUrl (url-normalize) does the actual URL
// extraction downstream, so this only routes raw values into the payload.
export function payloadFromQuery(search: string): SharePayload {
  const p = new URLSearchParams(search);
  const u = p.get("u") ?? p.get("url") ?? undefined;
  const text = p.get("text") ?? undefined;
  return { ...(u ? { url: u } : {}), ...(text ? { text } : {}) };
}
```

The only new headless-tested logic in 07a. `URLSearchParams` handles percent-decoding.

### 2.2 `capture.html` + `src/capture-view.ts` (new, DOM glue, untested per repo convention)

The deep-link landing page. On load:
1. `const payload = payloadFromQuery(location.search)`.
2. If `payload` has no `url`/`text` → `location.replace("/")` (nothing to capture; degrade to home).
3. Else `const store = await createPendingStore(); const r = await handleCapture(payload, store)`.
4. Fire-and-forget `drainAll(store, collections)` (same as the SW share path).
5. `location.replace(capturedRedirectUrl(r.status, r.record?.id))` → the existing toast/chips screen.

Pure reuse of `handleCapture` (parse → dedupe → persist to "Saved" → `synced=false`), so dedupe,
offline-first, and the "Saved" default all hold automatically (PRD §4.2). Identity comes from the PWA
session via the store/`getUserId` path, never from the deep link (PRD §4.2).

### 2.3 `src/clipboard-capture.ts` + a button in `index.html` (new, DOM glue, untested)

A **"Paste a reel link"** button on the home screen. On click (user gesture):
1. `const text = await navigator.clipboard.readText()` (guarded; if unavailable/denied → toast
   "Couldn't read clipboard").
2. `const payload: SharePayload = { text }`.
3. If `parse(payload).parseOk` is false → toast "No Instagram link found on your clipboard." and stop
   (do **not** persist garbage — clipboard content is arbitrary, unlike the Shortcut's deep link).
4. Else `handleCapture(payload, store)` → `drainAll` → `location.assign(capturedRedirectUrl(...))`.

`extractReelUrl` already pulls a reel URL out of surrounding text, satisfying PRD §4.1/§4.3's
"robust to URL vs text" requirement with zero new parsing.

### 2.4 Wiring (existing files)

- `src/sw.ts`: add `/capture.html` to `SHELL`; bump `CACHE` `insave-shell-v4` → `insave-shell-v5`
  (the activate handler purges the old cache). Navigation is already network-first, so the new page is
  served fresh; precaching it keeps the deep-link capture working offline-first.
- `vite.config.ts`: add `capture.html` to the Rollup input list (alongside index/captured/collection)
  so it is built and emitted.
- `index.html`: add the "Paste a reel link" button + a small toast element; load
  `src/clipboard-capture.ts`.

## 3. Data flow

```
iOS Shortcut (07b)  OR  user pastes
        │ opens https://…/capture?u=URL          │ taps "Paste a reel link"
        ▼                                          ▼
 capture-view: payloadFromQuery(search)     clipboard-capture: {text: clipboard}
        └──────────────► handleCapture(payload, store) ◄──────────┘
                          (parse → dedupe → persist "Saved", synced=false)
                                   │
                          drainAll → /api/sync (+ /api/collections)
                                   │
                          redirect → captured.html (toast + optional chip)
```

Identical to the Android `/share` path from `handleCapture` onward — same dedupe, same offline-first
persistence, same sync, same confirmation UI.

## 4. Error handling

- No URL in the deep-link query → redirect to `/` (graceful degrade, no silent drop; PRD §4.2).
- `handleCapture` returns `error`/`unparsed` → `capturedRedirectUrl` carries that status to the
  existing `captured.html` copy (unchanged).
- Clipboard unreadable (no API / permission denied / empty) → toast, no capture.
- Clipboard text has no reel URL → toast "No Instagram link found", no persist.
- `drainAll` failure → silent, retries on next trigger (existing contract).

## 5. Files touched (07a)

| File | Change |
|---|---|
| `src/share-query.ts` (new) | pure `payloadFromQuery(search)` |
| `tests/share-query.test.ts` (new) | headless tests (§6) |
| `capture.html` (new) | deep-link landing page; loads `capture-view.ts` |
| `src/capture-view.ts` (new) | deep-link glue → `handleCapture` → `captured.html` |
| `src/clipboard-capture.ts` (new) | clipboard button glue → `handleCapture` |
| `index.html` | "Paste a reel link" button + toast; load `clipboard-capture.ts` |
| `src/sw.ts` | add `/capture.html` to SHELL; `CACHE` v4→v5 |
| `vite.config.ts` | add `capture.html` build input |

No backend / D1 / schema / dependency change. No change to `handleCapture`, `parse`, `captured.html`.

## 6. Tests (TDD, headless — `tests/share-query.test.ts`, `environment: node`)

Only `payloadFromQuery` is new logic; extraction/dedupe/offline are already covered by
`url-normalize`, `capture`, and store tests. The DOM glue (pages, button, clipboard) is untested per
repo convention (no jsdom).

1. `payloadFromQuery("?u=https%3A%2F%2Fwww.instagram.com%2Freel%2FABC")` →
   `{ url: "https://www.instagram.com/reel/ABC" }` (percent-decoded).
2. Precedence: `"?url=X&text=Y"` → `{ url: "X", text: "Y" }`; `"?u=A&url=B"` → `url` is `"A"` (u wins).
3. `"?text=Saw%20this%20https://www.instagram.com/reel/XYZ"` → `{ text: "Saw this https://www.instagram.com/reel/XYZ" }` (text passthrough; extraction happens downstream).
4. `""` and `"?foo=bar"` → `{}` (no url/text/title keys).

**Relied on, already green:** `extractReelUrl`/`parse` (url-normalize) for URL-vs-text extraction;
`handleCapture` for dedupe + "Saved" persistence + offline-first; `capturedRedirectUrl` for the
redirect.

## 7. Acceptance (the PRD 07 ACs satisfiable in 07a)

- [ ] Sharing a reel URL to `https://…/capture?u=<url>` captures it into "Saved" via the existing
      pipeline, attributed to the logged-in PWA user, and lands on the `captured.html` confirmation.
- [ ] The deep-link capture degrades gracefully (redirect to home) when no URL is present — no silent
      reel loss.
- [ ] The deep-link capture works offline-first (persist locally, drain later), consistent with PRD 01.
- [ ] Clipboard fallback captures a copied reel link on a button tap, without paste/typing; arbitrary
      non-reel clipboard content is rejected with a message, not saved.
- [ ] Robust to the URL arriving as a bare URL or embedded in text (reuses `extractReelUrl`).

(The iOS-specific ACs — Shortcut in the share sheet, Safari onboarding, on-device reminders,
subscription re-validation — are 07b.)

## 8. Out of scope for 07a (→ 07b)

The iCloud Shortcut artifact and its share-sheet registration; iOS/Safari/in-app-browser detection;
the iOS onboarding screen; push subscription re-validation on open + backend stale-subscription
handling. **Device-verification risk owned by 07b:** on iOS the Shortcut's `https://…/capture?u=` must
actually open the *installed PWA* (not a separate Safari tab, which may use a different storage
partition) — verify on a real device; the clipboard fallback sidesteps this since the user opens the
PWA themselves. 07a's logic is correct regardless of which surface it runs in.
