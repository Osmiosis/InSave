# Design: PRD01 — Capture + Share Target

**Project:** InSave
**Source PRD:** `PRD's/01-capture-and-share-target.md`
**Date:** 2026-06-16
**Status:** Approved (pending spec review)

## Decisions locked during brainstorming

- **Stack:** Plain Vite + TypeScript, no UI framework. Static build on Cloudflare Pages; one Cloudflare Worker for the backend sync endpoint.
- **Backend store:** Cloudflare D1 (SQLite).
- **Confirmation UX:** Brief auto-dismissing toast (~1.5s) — `Saved. Tag it later.` / `Already in InSave` / `Saved — needs a look later.`
- **Sync retry strategy:** `online` event + on-launch drain. No Background Sync API (`SyncManager`) — simpler, sufficient, no support gaps.

## 1. Purpose (scope of this build)

Implement the capture fast path defined in PRD01: an installed Android PWA that registers in Instagram's share sheet, receives a shared reel, persists it to a durable local pending queue in well under a second, releases the user immediately, and later syncs to a Cloudflare D1 backend. No tagging, enrichment, or reminders (later PRDs).

## 2. Architecture

```
Instagram share sheet
   │  POST (multipart/form-data: url, title, text)
   ▼
share_target URL  /share  ──intercepted by──▶  Service Worker (fetch handler)
   │                                              │ parse → normalize → dedupe(local) → write IndexedDB
   │                                              │ 303 redirect → /captured?status=saved|dup|unparsed
   ▼                                              ▼
/captured page (vanilla TS)  ──shows toast, auto-dismiss, return to Instagram
   │
   └─ background: SW sync drain  ──▶  Worker /api/sync  ──▶  D1 (upsert on canonical_url)
```

### Why the service worker intercepts the POST

`share_target` with `method: POST` arrives as an ordinary network request to the registered URL. A static Pages site cannot run server code on that request, but the service worker's `fetch` handler can intercept it. The SW performs all *synchronous* capture work locally against IndexedDB, then issues a `303` redirect to a lightweight UI page. This:

- keeps capture fully functional offline,
- keeps the hot path sub-second (no network on the critical path),
- keeps the share-target endpoint "dumb and fast" per PRD §8.

Backend D1 sync is fire-and-forget *after* the user is released.

## 3. Components

Each unit has one purpose, a defined interface, and is testable in isolation.

### 3.1 `src/url-normalize.ts` (pure, no I/O)
- `extractReelUrl(payload: { url?: string; text?: string; title?: string }): string | null`
  Checks all fields; recovers an Instagram reel URL embedded in `text` if `url` is absent.
- `canonicalize(rawUrl: string): string`
  Strips tracking query params (`igsh`, `igshid`, `utm_*`, etc.), unifies trailing slashes, resolves obvious share-link variants. Produces the dedupe key.
- `parse(payload): { canonicalUrl: string | null; parseOk: boolean }`
  Combines the two; `parseOk=false` when no usable Instagram URL found.

### 3.2 `src/pending-store.ts` (IndexedDB wrapper, storage only)
- `put(record): Promise<void>`
- `getByCanonicalUrl(canonicalUrl): Promise<PendingCapture | undefined>` — dedupe lookup
- `listUnsynced(): Promise<PendingCapture[]>`
- `markSynced(ids: string[]): Promise<void>`

No business logic; just persistence.

### 3.3 `src/capture.ts` (orchestration, used by the SW)
- `handleCapture(payload, store): Promise<CaptureResult>`
  Flow: `parse` → if a canonical URL exists, `getByCanonicalUrl` to dedupe → write a pending record if new → classify.
- `CaptureResult = { status: "saved" | "dup" | "unparsed" }`
- Unparsed payloads are **still written** (`parse_ok=false`), never dropped.

### 3.4 `src/sw.ts` (service worker)
- Precaches the app shell + `/captured` for offline launch.
- `fetch` handler for `POST /share`: reads `formData`, calls `handleCapture`, returns `303 → /captured?status=...`.
- Sync drain: on `online` event and on SW activation, `listUnsynced` → batch POST to `/api/sync` → `markSynced` on success. Failures are swallowed and retried on the next trigger.

### 3.5 `src/captured.ts` + `public/captured.html`
- Reads `?status`, shows the matching toast, auto-dismisses ~1.5s.
- Attempts an unobtrusive return to Instagram (`history.back()`, falling back to closing/blanking). Dismissible by tap.

### 3.6 `worker/index.ts` (Cloudflare Worker — `POST /api/sync`)
- Accepts a JSON batch of pending records.
- Upserts into D1 keyed on `canonical_url` (`INSERT ... ON CONFLICT(canonical_url) DO NOTHING` style) — backend dedup is idempotent, so re-sync is safe.
- Returns the set of accepted ids.

### 3.7 `public/manifest.webmanifest`
- `share_target`: `{ action: "/share", method: "POST", enctype: "multipart/form-data", params: { title: "title", text: "text", url: "url" } }`
- Install metadata (`name`, `short_name: "InSave"`, icons, `display: "standalone"`, `start_url`).

### 3.8 D1 schema (`schema.sql`)
`pending_capture` per PRD §7:
| column | type | notes |
|---|---|---|
| `id` | TEXT PK | client-generated (UUID) |
| `canonical_url` | TEXT UNIQUE | dedupe key |
| `raw_payload` | TEXT | JSON of original title/text/url |
| `captured_at` | INTEGER | epoch ms |
| `source` | TEXT | `"share_target"` |
| `status` | TEXT | `"pending"` (PRD 03 owns transitions) |
| `parse_ok` | INTEGER | 0/1 |

The IndexedDB record uses the same shape plus a local `synced` flag.

## 4. Data flow & state rules

- Dedupe checks local IndexedDB across **all** local records (pending or already-synced), keyed on `canonical_url`.
- `parse_ok=false` items are persisted and surfaced for later review, never silently dropped (PRD §6.2).
- `/api/sync` upserts idempotently, so a record synced twice collapses on the backend too.
- `status` remains `"pending"`; transitions are out of scope (PRD 03).
- `id` is client-generated (UUID) so local records have stable identity before they reach the backend.

## 5. Error handling

| Situation | Behavior |
|---|---|
| No usable URL in payload | Write `parse_ok=false`, status `pending`; toast `Saved — needs a look later.` |
| Offline / Worker unreachable | Capture already succeeded locally; sync retries silently on reconnect. No blocking error. |
| Duplicate canonical URL | No second record; toast `Already in InSave`. |
| IndexedDB write fails (only true failure) | Toast `Couldn't save, try again` — the single case we surface a problem. |

## 6. Testing strategy

### Automated (Vitest)
- **`url-normalize`** — many Instagram URL / share-text shapes; tracking-param stripping; that two share variants of the same reel canonicalize identically; `parseOk=false` when no URL.
- **`capture`** — orchestration over a fake store: saved / dup / unparsed branches; verifies unparsed is still written.
- **`pending-store`** — against `fake-indexeddb`: put/get/listUnsynced/markSynced round-trips.

### Manual verification (real Android device required — documented, not automated)
The acceptance items that depend on a real device + installed PWA + live Instagram payload:
- Installed PWA appears in Instagram's Android share sheet as "InSave".
- Real Instagram payload field shape confirmed (which field carries the URL).
- Capture feels sub-1s on a mid-range device.
- Offline capture then auto-sync on reconnect.

These go in a `docs/manual-verification.md` checklist.

## 7. Repo layout

```
src/
  url-normalize.ts
  pending-store.ts
  capture.ts
  captured.ts
  sw.ts
  types.ts
public/
  index.html
  captured.html
  manifest.webmanifest
  icons/...
worker/
  index.ts
schema.sql
tests/
  url-normalize.test.ts
  capture.test.ts
  pending-store.test.ts
vite.config.ts
wrangler.toml
tsconfig.json
package.json
docs/manual-verification.md
```

## 8. Acceptance criteria mapping (PRD §9)

| PRD criterion | Covered by |
|---|---|
| Appears in Instagram share sheet | `manifest.webmanifest` `share_target` + manual verification |
| One pending record, normalized canonical URL | `capture` + `url-normalize` + unit tests |
| User released with no required interaction | SW `303` → auto-dismiss `/captured` |
| No duplicate on re-share; "already saved" | `capture` dedupe + `dup` toast + tests |
| Offline capture, later sync | IndexedDB write + `online`/launch drain |
| No-URL payload preserved as `parse_ok=false` | `capture` unparsed branch + test |
| No enrichment/tagging/reminder on capture path | Architecture: SW does parse/normalize/dedupe/persist/confirm only |

## 9. Out of scope (deferred)

Onboarding/install UX, enrichment/thumbnail fetch, backlog import, tagging, reminders, iOS capture. Architecture leaves room for the iOS Shortcut channel later (capture is keyed on `source`, swap the channel without touching storage/sync).
```