# PRD 07a — iOS capture entry points Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new entry points into the existing capture pipeline — a deep-link page (`/capture?u=<url>`) and a clipboard "Paste a reel link" button — both routing into `handleCapture` and the existing `captured.html` confirmation.

**Architecture:** No new capture logic. The only new pure unit maps a deep-link query string to a `SharePayload`; everything else reuses `handleCapture` (parse → dedupe → persist "Saved" → sync), `drainAll`, and `capturedRedirectUrl`. The pages/button are thin DOM glue, gated by tsc + Vite build + the full headless suite (the repo does not unit-test DOM views).

**Tech Stack:** TypeScript, Vite, Vitest (`environment: node`), IndexedDB (`idb`), vanilla DOM, service worker.

## Global Constraints

- **No new dependencies.** Use only what's installed.
- **Tests are headless** (`environment: "node"`, files under `tests/`). Do **not** add jsdom. DOM glue is untested by repo convention.
- **No backend/D1/schema change.** No change to `handleCapture`, `parse`, or `captured.html`.
- **Deep-link param precedence:** `u → url → text` (`u` is primary; `url`/`text` are aliases).
- **Capture must reuse `handleCapture`** so dedupe, "Saved" default (`status: "pending"`, `synced=false`), offline-first, and identity-from-PWA-session all hold automatically.
- **Commit trailer on every commit:**
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```
- Spec: `docs/superpowers/specs/2026-06-26-prd07a-ios-capture-entrypoints-design.md`.

## File Structure

| File | Responsibility |
|---|---|
| `src/share-query.ts` (new) | Pure `payloadFromQuery(search)` — the only new unit-tested logic |
| `tests/share-query.test.ts` (new) | Headless tests for the helper |
| `capture.html` + `src/capture-view.ts` (new) | Deep-link landing page → `handleCapture` → `captured.html` |
| `src/clipboard-capture.ts` (new) + `index.html` | Clipboard button → `handleCapture` → `captured.html` |
| `src/sw.ts`, `vite.config.ts` (modify) | Precache + build the new page |

---

### Task 1: `payloadFromQuery` pure helper

**Files:**
- Create: `src/share-query.ts`
- Test: `tests/share-query.test.ts`

**Interfaces:**
- Consumes: `SharePayload` from `src/types.ts` (shape `{ url?: string; text?: string; title?: string }`).
- Produces: `export function payloadFromQuery(search: string): SharePayload`.

- [ ] **Step 1: Write the failing test**

Create `tests/share-query.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { payloadFromQuery } from "../src/share-query";

describe("payloadFromQuery", () => {
  it("decodes a u= param into the url field", () => {
    expect(payloadFromQuery("?u=https%3A%2F%2Fwww.instagram.com%2Freel%2FABC")).toEqual({
      url: "https://www.instagram.com/reel/ABC",
    });
  });

  it("prefers u over url, and keeps text alongside", () => {
    expect(payloadFromQuery("?u=A&url=B&text=Y")).toEqual({ url: "A", text: "Y" });
  });

  it("falls back to url when u is absent", () => {
    expect(payloadFromQuery("?url=B")).toEqual({ url: "B" });
  });

  it("passes text through untouched (extraction happens downstream)", () => {
    expect(payloadFromQuery("?text=Saw+this+https://www.instagram.com/reel/XYZ")).toEqual({
      text: "Saw this https://www.instagram.com/reel/XYZ",
    });
  });

  it("returns an empty payload when no recognized param is present", () => {
    expect(payloadFromQuery("")).toEqual({});
    expect(payloadFromQuery("?foo=bar")).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- share-query`
Expected: FAIL — `Cannot find module '../src/share-query'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/share-query.ts`:

```ts
import type { SharePayload } from "./types";

// Maps a deep-link query string to a SharePayload for the existing capture
// pipeline. `u` is the canonical param the iOS Shortcut sends; `url`/`text`
// are accepted aliases. extractReelUrl (url-normalize) does the actual URL
// extraction downstream, so this only routes raw values into the payload.
export function payloadFromQuery(search: string): SharePayload {
  const p = new URLSearchParams(search);
  const u = p.get("u") ?? p.get("url") ?? undefined;
  const text = p.get("text") ?? undefined;
  return { ...(u ? { url: u } : {}), ...(text ? { text } : {}) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- share-query`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/share-query.ts tests/share-query.test.ts
git commit -m "$(cat <<'EOF'
feat(prd07a): payloadFromQuery — deep-link query to SharePayload

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Deep-link capture page

DOM glue — untested by repo convention. Verified by tsc + Vite build + full suite staying green. Includes the SW precache + Vite build wiring the page needs.

**Files:**
- Create: `capture.html`, `src/capture-view.ts`
- Modify: `vite.config.ts`, `src/sw.ts`

**Interfaces:**
- Consumes: `payloadFromQuery` (Task 1); `createPendingStore` (`src/pending-store.ts`); `createCollectionsStore` (`src/collections-store.ts`); `handleCapture` (`src/capture.ts`, returns `{ status: string; record?: { id: string } }`); `drainAll` (`src/drain-all.ts`); `capturedRedirectUrl(status, id?)` (`src/captured-url.ts`).
- Produces: a built `/capture.html` route; nothing imports from it.

- [ ] **Step 1: Create the capture page**

Create `capture.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#111111" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <title>InSave — Saving…</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #111; color: #eee;
             display: grid; place-items: center; height: 100vh; }
      p { color: #aaa; }
    </style>
  </head>
  <body>
    <p>Saving to InSave…</p>
    <script type="module" src="/src/register-sw.ts"></script>
    <script type="module" src="/src/capture-view.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Create the deep-link glue**

Create `src/capture-view.ts`:

```ts
import { payloadFromQuery } from "./share-query";
import { createPendingStore } from "./pending-store";
import { createCollectionsStore } from "./collections-store";
import { handleCapture } from "./capture";
import { drainAll } from "./drain-all";
import { capturedRedirectUrl } from "./captured-url";

async function main(): Promise<void> {
  const payload = payloadFromQuery(location.search);
  // Nothing to capture (Shortcut misfire / hand-typed link) — degrade to home,
  // never silently drop.
  if (!payload.url && !payload.text) {
    location.replace("/");
    return;
  }

  const store = await createPendingStore();
  let status = "error";
  let id: string | undefined;
  try {
    const result = await handleCapture(payload, store);
    status = result.status;
    id = result.record?.id;
    const collections = await createCollectionsStore();
    drainAll(store, collections).catch(() => {}); // fire-and-forget; retries later
  } catch {
    status = "error";
  }
  location.replace(capturedRedirectUrl(status, id));
}

void main();
```

- [ ] **Step 3: Add the page to the Vite build**

In `vite.config.ts`, add a `capture` input to `rollupOptions.input` (after the `review` line):

```ts
        review: resolve(__dirname, "review.html"),
        capture: resolve(__dirname, "capture.html"),
        sw: resolve(__dirname, "src/sw.ts"),
```

- [ ] **Step 4: Precache the page + bump the SW cache**

In `src/sw.ts`, add `/capture.html` to the `SHELL` array and bump the cache version:

```ts
const SHELL = ["/", "/index.html", "/captured.html", "/collection.html", "/cleanup.html", "/review.html", "/capture.html", "/manifest.webmanifest"];
// Bump on any SW behavior change so activate() purges the previous cache.
const CACHE = "insave-shell-v5";
```

- [ ] **Step 5: Typecheck + build + full suite**

Run: `npm run build`
Expected: `tsc` passes with no errors; Vite build succeeds and emits `capture.html`.

Run: `npm test`
Expected: PASS — all existing tests plus Task 1's 5 new tests; no regressions.

- [ ] **Step 6: Manual smoke (DOM, not automated)**

Run `npm run dev`, open `http://localhost:5173/capture?u=https://www.instagram.com/reel/ABC`. Expected: it captures and lands on `captured.html` with the toast. Open `http://localhost:5173/capture` (no param) → redirects to `/`. If a local run isn't available, record this as deferred to the deployment smoke check.

- [ ] **Step 7: Commit**

```bash
git add capture.html src/capture-view.ts vite.config.ts src/sw.ts
git commit -m "$(cat <<'EOF'
feat(prd07a): deep-link capture page (/capture?u=) into existing pipeline

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Clipboard fallback

DOM glue — untested by repo convention. Verified by tsc + Vite build + full suite staying green.

**Files:**
- Create: `src/clipboard-capture.ts`
- Modify: `index.html`

**Interfaces:**
- Consumes: `parse` (`src/url-normalize.ts`, returns `{ canonicalUrl: string; parseOk: boolean }`); `handleCapture`, `createPendingStore`, `createCollectionsStore`, `drainAll`, `capturedRedirectUrl` (as in Task 2); `SharePayload` (`src/types.ts`).
- Produces: a `#paste-link` button handler; nothing imports from it.

- [ ] **Step 1: Create the clipboard glue**

Create `src/clipboard-capture.ts`:

```ts
import { createPendingStore } from "./pending-store";
import { createCollectionsStore } from "./collections-store";
import { handleCapture } from "./capture";
import { drainAll } from "./drain-all";
import { capturedRedirectUrl } from "./captured-url";
import { parse } from "./url-normalize";
import type { SharePayload } from "./types";

const btn = document.getElementById("paste-link") as HTMLButtonElement | null;
const toast = document.getElementById("toast");

function showToast(msg: string): void {
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 2500);
}

async function pasteCapture(): Promise<void> {
  let text = "";
  try {
    text = await navigator.clipboard.readText(); // iOS: must run inside the click gesture
  } catch {
    showToast("Couldn't read clipboard");
    return;
  }

  const payload: SharePayload = { text };
  if (!parse(payload).parseOk) {
    showToast("No Instagram link found on your clipboard");
    return;
  }

  const store = await createPendingStore();
  try {
    const result = await handleCapture(payload, store);
    const collections = await createCollectionsStore();
    drainAll(store, collections).catch(() => {}); // fire-and-forget
    location.assign(capturedRedirectUrl(result.status, result.record?.id));
  } catch {
    showToast("Couldn't save — try again");
  }
}

btn?.addEventListener("click", () => {
  void pasteCapture();
});
```

- [ ] **Step 2: Add the button + script to the home page**

In `index.html`, change the actions line (currently
`<div class="actions"><button id="new-collection">+ New collection</button></div>`) to:

```html
    <div class="actions">
      <button id="new-collection">+ New collection</button>
      <button id="paste-link">Paste a reel link</button>
    </div>
```

And add the module script after the existing `collections-home.ts` script (before `</body>`):

```html
    <script type="module" src="/src/collections-home.ts"></script>
    <script type="module" src="/src/clipboard-capture.ts"></script>
```

- [ ] **Step 3: Typecheck + build + full suite**

Run: `npm run build`
Expected: `tsc` passes; Vite build succeeds.

Run: `npm test`
Expected: PASS — no regressions (still 5 new tests from Task 1; this task adds none).

- [ ] **Step 4: Manual smoke (DOM, not automated)**

Run `npm run dev`, open `/`, copy `https://www.instagram.com/reel/ABC` to the clipboard, tap **Paste a reel link** → expect capture → `captured.html`. Copy plain text "hello" and tap → expect the "No Instagram link found" toast, no capture. If a local run isn't available, record as deferred to deployment smoke.

- [ ] **Step 5: Commit**

```bash
git add src/clipboard-capture.ts index.html
git commit -m "$(cat <<'EOF'
feat(prd07a): clipboard fallback — Paste a reel link into existing pipeline

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- §2.1 `payloadFromQuery` → Task 1. ✓
- §2.2 deep-link page (`payloadFromQuery` → `handleCapture` → `drainAll` → `capturedRedirectUrl`; empty → home) → Task 2 Steps 1–2. ✓
- §2.3 clipboard button (gesture-gated read; reject non-reel; else capture) → Task 3 Step 1. ✓
- §2.4 wiring: SW SHELL + `CACHE` v4→v5 → Task 2 Step 4; Vite input → Task 2 Step 3; index button+script → Task 3 Step 2. ✓
- §3 data flow: both entry points converge on `handleCapture` → `drainAll` → `captured.html` → Tasks 2 & 3. ✓
- §4 error handling: no-URL→home (T2 S2); clipboard unreadable / non-reel toasts (T3 S1); `drainAll` fire-and-forget (T2 S2, T3 S1). ✓
- §6 tests: `payloadFromQuery` cases incl. precedence, decode, text passthrough, empty → Task 1 Step 1 (5 cases). ✓
- §7 acceptance: deep-link capture to Saved (T2); graceful degrade (T2 S2); offline-first (reuses `handleCapture`); clipboard fallback + non-reel rejection (T3); URL-vs-text robustness (reuses `extractReelUrl`). ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". All code shown in full. ✓

**Type consistency:** `payloadFromQuery(search: string): SharePayload` defined in Task 1, consumed in Task 2 Step 2 with that signature. `handleCapture(payload, store)` → `{ status, record?: { id } }` used identically in Tasks 2 & 3 (matches `src/capture.ts`). `capturedRedirectUrl(status, id?)`, `drainAll(store, collections)`, `parse(payload).parseOk` all match their source modules. `#toast` reused from existing `index.html`; `#paste-link` added in Task 3 Step 2 and referenced in Task 3 Step 1. ✓
