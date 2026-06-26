# PRD 07b — iOS onboarding + platform detection + push reliability (design)

**Project:** InSave
**Parent PRD:** `PRD's/07-iphone-capture-ios-shortcut.md`
**Sibling (prev):** PRD 07a — PWA capture entry points (deep-link `/capture?u=` + clipboard fallback)
**Status:** Approved design, pre-plan
**Date:** 2026-06-26

---

## 0. Scope

07a shipped the iOS *capture* entry points (the `/capture?u=` deep-link the Shortcut will open, and the
clipboard fallback). 07b adds the iOS *front door*: platform detection, an iOS onboarding screen, and
the client half of push reliability.

**What this PRD builds (code):** iOS/Safari/in-app-browser detection (testable), an iOS onboarding page
+ an iOS-only banner on the home, a config slot for the Shortcut's iCloud URL, and client-side push
re-validation on app open.

**What is a manual handoff (device-bound, NOT code):** building the iCloud Shortcut in Apple's
Shortcuts app and pasting its share link into the config; and on-device verification (install,
reminders, capture). These are done by the user; the implementer pauses and prompts at each.

**Already done — not rebuilt here:** the backend half of push reliability. `worker/notify.ts` already
prunes a dead subscription on a `gone` (404/410) send. No worker/schema change in 07b.

## 1. Decisions carried in from brainstorming (2026-06-26)

- Build the full code path now; **pause and hand off to the user** for each device step (Shortcut
  build, iCloud link, on-device verification).
- No screenshots (cannot produce real iOS captures) — onboarding uses clear CSS-styled step cards.
- The Shortcut URL is a **config constant**, empty by default; the onboarding shows the clipboard path
  until it is set, and lights up an "Add the InSave shortcut" button once it is.
- Detection drives an **iOS-only banner** on the home, shown only when `ios && !standalone` (i.e. an
  iPhone user who has not yet installed the PWA).

## 2. Components

### 2.1 `src/platform.ts` (new, pure, tested)

```ts
export interface Platform { ios: boolean; inAppBrowser: boolean; standalone: boolean; }

export function detectPlatform(ua: string, isStandalone: boolean): Platform {
  const ios = /iphone|ipad|ipod/i.test(ua);
  const inAppBrowser = /FBAN|FBAV|Instagram|Line\/|Twitter|Snapchat|Pinterest|TikTok/i.test(ua);
  return { ios, inAppBrowser, standalone: isStandalone };
}
```

The only new headless-tested logic. Callers compute `isStandalone` from the platform APIs:
`(navigator as any).standalone === true || window.matchMedia("(display-mode: standalone)").matches`.

### 2.2 `src/ios-config.ts` (new)

```ts
// Set this to the iCloud share link once the InSave Shortcut is built (07b handoff).
// Empty ⇒ onboarding shows the clipboard path and the manual recipe instead of a one-tap button.
export const SHORTCUT_URL = "";
```

### 2.3 `ios.html` + `src/ios-onboarding.ts` (new, DOM glue, untested per convention)

A focused step guide rendered as CSS step-cards:

1. **Install** — "In Safari: Share → Add to Home Screen." If `detectPlatform(...).inAppBrowser`, replace
   Step 1 with an "Open in Safari first" notice (Add-to-Home-Screen is unavailable in in-app browsers).
2. **Reminders** — "Open InSave from the home screen → Enable reminders" (links to `/` where the
   `Enable reminders` button lives).
3. **Capture** — if `SHORTCUT_URL` is non-empty, render an **"Add the InSave shortcut"** anchor to it;
   **always** render the clipboard fallback instructions ("In Instagram: Share → Copy link; in InSave
   tap **Paste a reel link**") as the zero-setup path.

`ios-onboarding.ts` reads `detectPlatform(navigator.userAgent, <isStandalone>)` to choose the in-app
vs Safari variant of Step 1, and `SHORTCUT_URL` to decide the Step 3 button. If already `standalone`,
show a brief "You're set up — saving works from the home-screen app" confirmation instead of Step 1.

### 2.4 `index.html` iOS banner (DOM glue)

On the home, a hidden banner element. A small inline/module script computes
`detectPlatform(navigator.userAgent, isStandalone)`; if `ios && !standalone`, reveal a banner —
**"📱 On iPhone? Finish setup →"** linking to `/ios.html`. Non-iOS and installed users never see it.
(Wire via the existing home script set; reuse the detection helper.)

### 2.5 `src/push-subscribe.ts` (new) + `push-enable.ts` refactor

Extract the subscribe logic into a reusable function:

```ts
import { VAPID_PUBLIC_KEY, urlBase64ToUint8Array } from "./push-config";
import { getUserId } from "./db";

// Ensures a live push subscription exists and is registered server-side.
// Safe to call repeatedly; re-subscribes if iOS silently dropped the subscription.
export async function ensureSubscription(): Promise<boolean> {
  if (Notification.permission !== "granted") return false;
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

- `push-enable.ts` (the button) calls `Notification.requestPermission()` then `ensureSubscription()`
  (keeping its existing button-state UI), instead of inlining the subscribe + POST.
- **On app open** (in `register-sw.ts` or a small module on the home), best-effort call
  `ensureSubscription().catch(() => {})` so a silently-expired iOS subscription is re-minted and
  re-registered (re-POST refreshes `created_at`). Guarded by `Notification.permission === "granted"`
  inside the function, so it is a no-op for users who never enabled reminders.

The backend already prunes dead endpoints (`notify.ts` on `gone`), so re-subscribe + server-side prune
together keep the subscription table healthy. No worker change.

### 2.6 Wiring (existing files)

- `src/sw.ts`: add `/ios.html` to `SHELL`; bump `CACHE` `insave-shell-v5` → `insave-shell-v6`.
- `vite.config.ts`: add `ios.html` to the Rollup input list.
- `index.html`: hidden banner element + load the detection/banner script.

## 3. Data flow

```
iOS user in Safari → index.html → detectPlatform → banner "Finish setup →" → ios.html
   ios.html steps: Add to Home Screen → (open PWA) → Enable reminders → capture (Shortcut or clipboard)

Reminders: Enable reminders button → requestPermission → ensureSubscription → POST /api/subscribe
App open (granted): ensureSubscription re-checks getSubscription, re-subscribes if dropped, re-POSTs
Dead endpoint on a later send: notify.ts deletes the subscription (already built)
```

## 4. Error handling

- In-app browser → Step 1 becomes "Open in Safari" (Add-to-Home-Screen degraded otherwise).
- `ensureSubscription` is best-effort on open (`.catch(() => {})`); the button path keeps its existing
  "Couldn't enable — try again" UI.
- `SHORTCUT_URL` empty → no Shortcut button; clipboard path always shown (no broken link).
- Non-iOS / installed → banner hidden; `ios.html` still reachable directly but shows the standalone
  confirmation when installed.

## 5. Files touched (07b)

| File | Change |
|---|---|
| `src/platform.ts` (new) | pure `detectPlatform(ua, isStandalone)` |
| `tests/platform.test.ts` (new) | headless UA matrix tests |
| `src/ios-config.ts` (new) | `SHORTCUT_URL` constant (empty default; handoff fills it) |
| `ios.html` (new) | iOS onboarding step guide |
| `src/ios-onboarding.ts` (new) | renders the steps from `detectPlatform` + `SHORTCUT_URL` |
| `src/push-subscribe.ts` (new) | `ensureSubscription()` |
| `src/push-enable.ts` | refactor to call `ensureSubscription()` |
| `register-sw.ts` (or a home module) | best-effort `ensureSubscription()` on open |
| `index.html` | hidden iOS banner + detection/banner script |
| `src/sw.ts` | add `/ios.html` to SHELL; `CACHE` v5→v6 |
| `vite.config.ts` | add `ios.html` build input |

No worker / D1 / schema / dependency change.

## 6. Tests (TDD, headless — `tests/platform.test.ts`, `environment: node`)

`detectPlatform` is the only new logic; the rest is untested DOM glue (no jsdom) and device-verified UX.

1. iPhone Safari UA → `{ ios: true, inAppBrowser: false, standalone: <passed> }`.
2. iPad UA → `ios: true`.
3. Instagram in-app browser UA (contains `Instagram`) on iPhone → `ios: true, inAppBrowser: true`.
4. Facebook in-app (`FBAN`/`FBAV`) → `inAppBrowser: true`.
5. Android Chrome UA → `ios: false, inAppBrowser: false`.
6. Desktop UA → `ios: false`.
7. `isStandalone` passthrough → `standalone` reflects the passed boolean.

**Relied on, already green / no new tests:** `notify.ts` dead-endpoint pruning (existing); the
`ensureSubscription` POST shape mirrors the existing `push-enable.ts` call.

## 7. Acceptance (PRD 07 §6 items satisfiable in 07b)

- [ ] iOS is detected; an iPhone-in-Safari (not installed) sees an onboarding entry; Android/desktop do
      not.
- [ ] The onboarding routes the user to Safari, shows Add-to-Home-Screen, the capture gesture
      (clipboard always; Shortcut button when configured), and the reminders step.
- [ ] An in-app browser is detected and the user is told to open in Safari.
- [ ] The push subscription is re-validated on app open (re-subscribed if iOS dropped it); the backend
      already tolerates/prunes stale subscriptions.
- [ ] A single universal Shortcut, once built, can be linked one-tap from onboarding (config slot).

(Real-device confirmation of install/push/Shortcut and the Shortcut artifact itself are handoffs.)

## 8. Out of scope

The token-carrying silent Shortcut and a native iOS app (PRD 07 §8, demand-driven). Per-user push
analytics. Any change to the capture pipeline (07a) or the reminder engine. The Shortcut artifact and
on-device verification are manual handoffs, not code.

## 9. Handoffs (the implementer pauses and prompts the user)

1. **Build the Shortcut:** after `ios.html` exists, the user creates the InSave Shortcut on their
   iPhone (recipe: a "Receive URLs/Text from Share Sheet" Shortcut that runs **Open URLs** with
   `https://insave.fgcworker.workers.dev/capture?u=[Shortcut Input]`, "Show in Share Sheet" on), shares
   it to iCloud, and sends the link. The implementer sets `SHORTCUT_URL` and commits.
2. **On-device verification:** install via Safari, enable reminders, capture via the Shortcut/clipboard,
   confirm reels land in "Saved" — the user runs these; the implementer records results.
