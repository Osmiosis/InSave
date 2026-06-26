# PRD 07b — iOS onboarding + push reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add iOS platform detection, an iOS onboarding page + home banner, a Shortcut-URL config slot, and client-side push re-validation on app open.

**Architecture:** One new pure tested helper (`detectPlatform`); everything else is thin DOM/push glue gated by tsc + Vite build + the headless suite (the repo does not unit-test DOM views). The backend half of push reliability already exists (`worker/notify.ts` prunes dead endpoints), so no worker change.

**Tech Stack:** TypeScript, Vite, Vitest (`environment: node`), service worker, Web Push.

## Global Constraints

- **No worker / D1 / schema / dependency change.**
- **Tests are headless** (`environment: "node"`, under `tests/`). No jsdom. DOM/push glue is untested by repo convention.
- **The Shortcut URL is a config constant**, empty by default (`SHORTCUT_URL = ""`); onboarding shows the clipboard path until it is set. Filling it is a later handoff — do NOT invent a URL.
- **App URL** for the Shortcut recipe / capture deep-link: `https://insave.fgcworker.workers.dev/capture?u=`.
- **`ensureSubscription` must be a no-op unless `Notification.permission === "granted"`** (guard first) so calling it on every app open is safe for users who never enabled reminders.
- **Commit trailer on every commit:**
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```
- Spec: `docs/superpowers/specs/2026-06-26-prd07b-ios-onboarding-design.md`.

## File Structure

| File | Responsibility |
|---|---|
| `src/platform.ts` (new) | pure `detectPlatform` (tested) + `currentPlatform` (DOM glue) |
| `tests/platform.test.ts` (new) | headless UA matrix |
| `src/push-subscribe.ts` (new) | `ensureSubscription()` |
| `src/push-enable.ts`, `src/register-sw.ts` (modify) | use `ensureSubscription`; re-validate on open |
| `src/ios-config.ts`, `ios.html`, `src/ios-onboarding.ts` (new) | onboarding page + Shortcut slot |
| `index.html`, `src/ios-banner.ts` (new) | iOS-only home banner |
| `src/sw.ts`, `vite.config.ts` (modify) | precache + build `ios.html` |

---

### Task 1: `detectPlatform` + `currentPlatform`

**Files:**
- Create: `src/platform.ts`, `tests/platform.test.ts`

**Interfaces:**
- Produces: `interface Platform { ios: boolean; inAppBrowser: boolean; standalone: boolean }`; `detectPlatform(ua: string, isStandalone: boolean): Platform`; `currentPlatform(): Platform`.

- [ ] **Step 1: Write the failing test**

Create `tests/platform.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { detectPlatform } from "../src/platform";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IG_INAPP = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 302.0.0.0";
const FB_INAPP = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS;FBAV/420.0.0]";
const ANDROID = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

describe("detectPlatform", () => {
  it("flags iPhone Safari as iOS, not in-app", () => {
    expect(detectPlatform(IPHONE, false)).toEqual({ ios: true, inAppBrowser: false, standalone: false });
  });
  it("flags iPad as iOS", () => {
    expect(detectPlatform(IPAD, false).ios).toBe(true);
  });
  it("flags an Instagram in-app browser on iPhone", () => {
    const p = detectPlatform(IG_INAPP, false);
    expect(p.ios).toBe(true);
    expect(p.inAppBrowser).toBe(true);
  });
  it("flags a Facebook in-app browser (FBAN/FBAV)", () => {
    expect(detectPlatform(FB_INAPP, false).inAppBrowser).toBe(true);
  });
  it("does not flag Android Chrome as iOS or in-app", () => {
    expect(detectPlatform(ANDROID, false)).toEqual({ ios: false, inAppBrowser: false, standalone: false });
  });
  it("does not flag desktop as iOS", () => {
    expect(detectPlatform(DESKTOP, false).ios).toBe(false);
  });
  it("passes the standalone flag through", () => {
    expect(detectPlatform(IPHONE, true).standalone).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- platform`
Expected: FAIL — `Cannot find module '../src/platform'`.

- [ ] **Step 3: Implement**

Create `src/platform.ts`:

```ts
export interface Platform {
  ios: boolean;
  inAppBrowser: boolean;
  standalone: boolean;
}

// Pure: classify a user-agent. `isStandalone` is supplied by the caller (it
// comes from platform APIs, not the UA string).
export function detectPlatform(ua: string, isStandalone: boolean): Platform {
  const ios = /iphone|ipad|ipod/i.test(ua);
  const inAppBrowser = /FBAN|FBAV|Instagram|Line\/|Twitter|Snapchat|Pinterest|TikTok/i.test(ua);
  return { ios, inAppBrowser, standalone: isStandalone };
}

// DOM glue (untested): reads the live navigator/window. Used by the onboarding
// page and the home banner.
export function currentPlatform(): Platform {
  const standalone =
    (navigator as unknown as { standalone?: boolean }).standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
  return detectPlatform(navigator.userAgent, standalone);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- platform`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform.ts tests/platform.test.ts
git commit -m "$(cat <<'EOF'
feat(prd07b): detectPlatform (iOS / in-app-browser / standalone) + currentPlatform

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `ensureSubscription` + push re-validation on open

DOM/push glue — untested by repo convention. Gated by tsc + Vite build + full suite.

**Files:**
- Create: `src/push-subscribe.ts`
- Modify: `src/push-enable.ts`, `src/register-sw.ts`

**Interfaces:**
- Consumes: `VAPID_PUBLIC_KEY`, `urlBase64ToUint8Array` (`src/push-config.ts`); `getUserId` (`src/db.ts`).
- Produces: `export async function ensureSubscription(): Promise<boolean>`.

- [ ] **Step 1: Create `ensureSubscription`**

Create `src/push-subscribe.ts`:

```ts
import { VAPID_PUBLIC_KEY, urlBase64ToUint8Array } from "./push-config";
import { getUserId } from "./db";

// Ensures a live push subscription exists and is registered server-side. Safe
// to call repeatedly and on every app open: a no-op unless notifications are
// granted, and it re-subscribes if iOS silently dropped the subscription.
export async function ensureSubscription(): Promise<boolean> {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    });
  }
  const user_id = await getUserId();
  await fetch("/api/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user_id, subscription: sub.toJSON() }),
  });
  return true;
}
```

- [ ] **Step 2: Refactor `push-enable.ts` to use it**

Replace the body of `src/push-enable.ts` with:

```ts
import { ensureSubscription } from "./push-subscribe";

const btn = document.getElementById("enable-reminders") as HTMLButtonElement | null;

async function enable(): Promise<void> {
  if (!btn) return;
  btn.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      btn.textContent = "Reminders blocked";
      btn.disabled = false;
      return;
    }
    await ensureSubscription();
    btn.textContent = "Reminders on ✓";
  } catch {
    btn.textContent = "Couldn't enable — try again";
    btn.disabled = false;
  }
}

btn?.addEventListener("click", () => {
  void enable();
});
```

- [ ] **Step 3: Re-validate on app open in `register-sw.ts`**

In `src/register-sw.ts`, add the import and a best-effort call (after the existing SW registration):

```ts
import { ensureSubscription } from "./push-subscribe";
```

and, after the `navigator.serviceWorker.register(...)` block:

```ts
// iOS can silently expire a push subscription; re-mint + re-register on open.
// No-op unless notifications were granted (guarded inside ensureSubscription).
void ensureSubscription().catch(() => {});
```

- [ ] **Step 4: Typecheck + build + full suite**

Run: `npm run build`
Expected: `tsc` clean; Vite build succeeds.

Run: `npm test`
Expected: PASS — all existing tests + Task 1's 7. No regressions.

- [ ] **Step 5: Commit**

```bash
git add src/push-subscribe.ts src/push-enable.ts src/register-sw.ts
git commit -m "$(cat <<'EOF'
feat(prd07b): ensureSubscription + re-validate push on app open

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: iOS onboarding page

DOM glue — untested. Gated by tsc + Vite build (emits `ios.html`) + full suite.

**Files:**
- Create: `src/ios-config.ts`, `ios.html`, `src/ios-onboarding.ts`
- Modify: `vite.config.ts`, `src/sw.ts`

**Interfaces:**
- Consumes: `currentPlatform` (Task 1); `SHORTCUT_URL` (this task).

- [ ] **Step 1: Create the config slot**

Create `src/ios-config.ts`:

```ts
// The iCloud share link for the InSave Shortcut. Empty until the Shortcut is
// built on-device (07b handoff) — onboarding then shows the clipboard path
// instead of a one-tap button. Do not invent a URL.
export const SHORTCUT_URL = "";
```

- [ ] **Step 2: Create the onboarding page**

Create `ios.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#111111" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <title>InSave — Set up on iPhone</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #111; color: #eee; }
      header { padding: 20px; }
      h1 { font-size: 1.3rem; margin: 0 0 8px; }
      p { color: #bbb; line-height: 1.5; margin: 6px 0; }
      a { color: #8ab4ff; }
      .step { border-top: 1px solid #222; padding: 16px 20px; }
      .step h2 { font-size: 1rem; margin: 0 0 6px; }
      .notice { background: #3a2a1a; border: 1px solid #5a3a1a; border-radius: 8px;
                padding: 12px; color: #f5d9b9; display: none; }
      .notice.show { display: block; }
      .hidden { display: none; }
      .confirm { display: none; padding: 16px 20px; color: #b9f5c9; }
      .confirm.show { display: block; }
      a.shortcut-btn { display: inline-block; background: #1e2a3a; border: 1px solid #3a5573;
                       border-radius: 8px; padding: 10px 14px; color: #b9d5f5; text-decoration: none; margin-top: 8px; }
    </style>
  </head>
  <body>
    <header>
      <h1>Set up InSave on iPhone</h1>
      <p><a href="/">← Back to InSave</a></p>
    </header>

    <div id="confirm" class="confirm">You're set up — InSave is installed. Saving works from the home-screen app.</div>

    <div id="steps">
      <section class="step" id="step-install">
        <div id="inapp-notice" class="notice">
          You're in an in-app browser. Open this page in <strong>Safari</strong> first —
          tap the <strong>•••</strong> menu → <strong>Open in Safari</strong> — then continue.
        </div>
        <div id="install-steps">
          <h2>1. Install for reminders</h2>
          <p>In <strong>Safari</strong>, tap the <strong>Share</strong> icon →
            <strong>Add to Home Screen</strong> → <strong>Add</strong>. Open InSave from the new
            home-screen icon.</p>
        </div>
      </section>

      <section class="step">
        <h2>2. Turn on reminders</h2>
        <p>Open InSave from the home screen, then tap <strong>Enable reminders</strong> and allow
          notifications.</p>
      </section>

      <section class="step">
        <h2>3. Save reels</h2>
        <div id="shortcut-slot"></div>
        <p><strong>Or paste a link (no setup):</strong> in Instagram, open a reel →
          <strong>Share</strong> → <strong>Copy link</strong>. In InSave, tap
          <strong>Paste a reel link</strong>.</p>
      </section>
    </div>

    <script type="module" src="/src/register-sw.ts"></script>
    <script type="module" src="/src/ios-onboarding.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Create the onboarding script**

Create `src/ios-onboarding.ts`:

```ts
import { currentPlatform } from "./platform";
import { SHORTCUT_URL } from "./ios-config";

const p = currentPlatform();

if (p.standalone) {
  // Already installed — show the confirmation, hide the steps.
  document.getElementById("confirm")?.classList.add("show");
  document.getElementById("steps")?.classList.add("hidden");
} else if (p.inAppBrowser) {
  // In-app browser — Add-to-Home-Screen is unavailable; route to Safari.
  document.getElementById("inapp-notice")?.classList.add("show");
  document.getElementById("install-steps")?.classList.add("hidden");
}

if (SHORTCUT_URL) {
  const slot = document.getElementById("shortcut-slot");
  if (slot) {
    const a = document.createElement("a");
    a.href = SHORTCUT_URL;
    a.className = "shortcut-btn";
    a.textContent = "Add the InSave shortcut";
    slot.appendChild(a);
  }
}
```

- [ ] **Step 4: Add to the Vite build**

In `vite.config.ts`, add an `ios` input to `rollupOptions.input` (after the `capture` line):

```ts
        capture: resolve(__dirname, "capture.html"),
        ios: resolve(__dirname, "ios.html"),
        sw: resolve(__dirname, "src/sw.ts"),
```

- [ ] **Step 5: Precache + bump the SW cache**

In `src/sw.ts`, add `/ios.html` to `SHELL` and bump the cache version:

```ts
const SHELL = ["/", "/index.html", "/captured.html", "/collection.html", "/cleanup.html", "/review.html", "/capture.html", "/ios.html", "/manifest.webmanifest"];
const CACHE = "insave-shell-v6";
```

- [ ] **Step 6: Typecheck + build + full suite**

Run: `npm run build`
Expected: `tsc` clean; Vite build emits `ios.html`.

Run: `npm test`
Expected: PASS — no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/ios-config.ts ios.html src/ios-onboarding.ts vite.config.ts src/sw.ts
git commit -m "$(cat <<'EOF'
feat(prd07b): iOS onboarding page (install / reminders / capture) + Shortcut slot

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: iOS-only home banner

DOM glue — untested. Gated by tsc + Vite build + full suite.

**Files:**
- Create: `src/ios-banner.ts`
- Modify: `index.html`

**Interfaces:**
- Consumes: `currentPlatform` (Task 1).

- [ ] **Step 1: Create the banner script**

Create `src/ios-banner.ts`:

```ts
import { currentPlatform } from "./platform";

// Show the iPhone setup banner only to an iOS user who has not installed the PWA.
const p = currentPlatform();
if (p.ios && !p.standalone) {
  document.getElementById("ios-banner")?.removeAttribute("hidden");
}
```

- [ ] **Step 2: Add the banner + style + script to `index.html`**

In `index.html`'s `<style>` block, after the `.toast` rules, add:

```css
      .ios-banner { display: block; margin: 8px 20px 0; padding: 10px 14px; background: #1e2a3a;
                    border: 1px solid #3a5573; border-radius: 8px; color: #b9d5f5; text-decoration: none; font-size: 14px; }
```

Immediately after `<body>`'s `<header>...</header>` block closes (before `<div class="actions">`), add:

```html
    <a id="ios-banner" class="ios-banner" href="/ios.html" hidden>📱 On iPhone? Finish setup →</a>
```

And add the module script alongside the existing ones (before `</body>`):

```html
    <script type="module" src="/src/ios-banner.ts"></script>
```

- [ ] **Step 3: Typecheck + build + full suite**

Run: `npm run build`
Expected: `tsc` clean; Vite build succeeds.

Run: `npm test`
Expected: PASS — no regressions.

- [ ] **Step 4: Commit**

```bash
git add src/ios-banner.ts index.html
git commit -m "$(cat <<'EOF'
feat(prd07b): iOS-only home banner linking to the onboarding page

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- §2.1 `detectPlatform`/`currentPlatform` → Task 1. ✓
- §2.2 `SHORTCUT_URL` config → Task 3 Step 1. ✓
- §2.3 onboarding page (install/in-app/reminders/capture; standalone confirm; Shortcut slot) → Task 3. ✓
- §2.4 iOS banner (`ios && !standalone`) → Task 4. ✓
- §2.5 `ensureSubscription` + push-enable refactor + on-open re-validation → Task 2. ✓
- §2.6 wiring: SW SHELL `/ios.html` + cache v5→v6 (Task 3 Step 5); vite `ios` input (Task 3 Step 4); index banner+script (Task 4). ✓
- §6 tests: `detectPlatform` UA matrix → Task 1 (7 cases). ✓
- §7 acceptance: detection+banner (T1/T4), onboarding routes+steps (T3), in-app nudge (T3), push re-validation (T2), Shortcut slot one-tap when configured (T3). ✓

**Placeholder scan:** `SHORTCUT_URL = ""` is the intended empty config slot (documented), not a stray placeholder. No TODO/TBD.

**Type consistency:** `detectPlatform(ua, isStandalone): Platform` and `currentPlatform(): Platform` defined in Task 1, consumed in Tasks 3 & 4. `ensureSubscription(): Promise<boolean>` defined Task 2, consumed by push-enable + register-sw. `SHORTCUT_URL: string` defined Task 3 Step 1, consumed by `ios-onboarding.ts` (same task). Element ids in `ios.html` (`confirm`, `steps`, `inapp-notice`, `install-steps`, `shortcut-slot`) match those toggled in `ios-onboarding.ts`; `ios-banner` id matches `index.html`. SW cache v5→v6 follows 07a's v5.
