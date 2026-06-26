# PRD 07: iPhone Capture via iOS Shortcut

**Project:** InSave
**Component:** iPhone capture path + iOS onboarding (bringing InSave to iOS, free)
**Platform target:** iOS (Safari-installed PWA for reminders + an iCloud Shortcut for capture), same Cloudflare backend
**Status:** Draft
**Relationship to existing PRDs:** Adds an iOS capture channel parallel to PRD 01's Android Web Share Target. Reuses the entire existing backend (capture endpoint, D1, sync, collections, reminder engine) unchanged.

---

## 0. Why this PRD exists

Goal: get InSave onto iPhone, for free, to reach more users. The blocker is structural and Apple-imposed: **iOS does not support Web Share Target**, so a PWA cannot insert itself into Instagram's share sheet the way it does on Android. That is the WebKit wall, not a gap in our code, and no free workaround reopens it.

What *does* work on iOS, all free:
- **Reminders** port directly. Since iOS 16.4, a PWA installed via **Safari → Add to Home Screen** can receive Web Push. Our cron + Web Push + D1 stack works on iOS as-is, provided the user installs the PWA via Safari and grants notification permission.
- **Capture** is solved with an **iOS Shortcut** added to the share sheet. The user shares a reel → taps the InSave shortcut → the reel is captured. To the user's thumb this is the same two taps as Android; it is a Shortcut talking to our backend, not our PWA in the sheet.

This PRD specifies the iOS capture path and onboarding. The explicit design priority is **making the one-time setup trivial**, because the per-save experience is already good; iPhone adoption lives or dies on setup friction.

## 1. The unavoidable limit (state plainly, do not pretend otherwise)

iPhone capture cannot be as frictionless as Android. Android shows InSave in the share sheet automatically; iOS requires the user to (a) install the PWA via Safari for reminders and (b) add an iCloud Shortcut for capture. Each step can be made trivial, but **they cannot be made to vanish** — Apple does not allow an automatic share-sheet entry for web apps. The win condition is not "as frictionless as Android"; it is "frictionless enough that a motivated user doesn't bounce." Everything below serves that bar.

## 2. The capture mechanism (v1 decision)

**Ship a single universal iCloud Shortcut that opens the installed PWA with the shared URL; the PWA (already logged in) performs the capture.**

Rationale (chosen over a token-carrying silent Shortcut):
- The Shortcut is **identical for every user** — it carries no secrets, no per-user token, nothing to personalize or leak. This is what makes setup truly "tap link → Add → done."
- **Identity lives in the PWA**, which the user is already logged into, so attribution needs no token injected into the Shortcut.
- Cost accepted: the app **visibly opens** for a moment on each save (less invisible than Android's silent capture). This is the deliberate trade for the simplest, safest setup.

This is the right v1 answer, not a placeholder. The silent/token version and a native app are **demand-driven upgrades** (see §8), built only if real iPhone users find the app-flash actually bothersome — not a committed roadmap.

## 3. User flow

### 3.1 One-time setup (must be trivial)
On an iOS onboarding screen, three actions, each one tap plus a system confirm:
1. **Install for reminders:** guide the user through Safari → Share → **Add to Home Screen**. (Screenshot the share-sheet step; iOS users will not guess it, and there is no automatic install prompt on iOS.) This installs the PWA (required for push) and is where notification permission is later granted (on an in-app "Enable reminders" tap).
2. **Add the capture shortcut:** the user taps **"Add the InSave shortcut"** → the iCloud link opens the pre-built Shortcut with an **Add Shortcut** button → tap Add. Nothing to configure. Ensure "Show in Share Sheet" is enabled in the Shortcut (pre-set in the shared artifact).
3. **Done.** Show the two-tap capture gesture with a screenshot ("reel → Share → Save to InSave").

### 3.2 Per-save (the good part)
1. In Instagram: tap **Share** → tap **Save to InSave** (the Shortcut).
2. The Shortcut opens the installed PWA with the reel URL (deep link).
3. The PWA captures it via the existing capture path (parse → normalize → dedupe → persist → sync), shows the existing brief confirmation, and the user returns to Instagram.
- The collection-chip surface (PRD 05) can apply here too: the deep-link capture lands in "Saved" by default, with the same optional one-tap collection re-target if shown. Zero-tap default preserved.

### 3.3 Reminders on iOS
- Identical to Android once the PWA is installed and permission granted: server cron → Web Push → notification with Done/Snooze. No iOS-specific engine changes.

## 4. Functional requirements

### 4.1 The iCloud Shortcut artifact
- MUST be a single, universal Shortcut shared via an iCloud link, carrying **no per-user data or secrets**.
- MUST appear in the iOS share sheet (the shared artifact ships with "Show in Share Sheet" enabled and accepts URLs / text).
- MUST extract the shared Instagram URL and open the InSave PWA via a deep link carrying that URL.
- MUST be robust to Instagram sharing the URL as text vs URL (same defensive extraction posture as PRD 01).

### 4.2 PWA deep-link capture
- The PWA MUST accept an inbound deep link containing a shared URL and route it into the **existing** capture pipeline (PRD 01 logic: normalize, dedupe, persist to "Saved" by default, sync). No new capture logic — a new *entry point* into the existing path.
- Capture MUST still work offline-first (persist locally, drain later), consistent with PRD 01.
- The deep-link capture MUST attribute to the logged-in user (identity from the PWA session, not the Shortcut).
- If the PWA is not installed / not logged in when the deep link fires, the flow MUST degrade gracefully (e.g. open onboarding / prompt install) rather than silently dropping the reel.

### 4.3 Clipboard fallback (for users who won't add the Shortcut)
- The PWA SHOULD support a clipboard capture path: the user copies the reel link (Instagram → Copy Link), opens InSave, and the pending reel is already detected from the clipboard, ready to confirm — no paste, no typing.
- This is the zero-setup fallback for users who skip the Shortcut. More friction per save (a context switch instead of a share-sheet tap), but nothing to install.
- Clipboard read MUST be triggered by a user action (iOS gates clipboard access), not silently on load.

### 4.4 iOS onboarding
- MUST provide an iOS-specific onboarding screen that (a) routes the user into **Safari** explicitly (the install/push path does not work from Chrome or in-app browsers on iOS — all iOS browsers are WebKit and only Safari's Add-to-Home-Screen yields a push-capable PWA), (b) shows the Add-to-Home-Screen step with a screenshot, (c) offers the "Add the InSave shortcut" iCloud link, (d) shows the capture gesture.
- MUST detect iOS and show this flow instead of the Android one.
- SHOULD detect if the user is in an in-app browser or non-Safari context and tell them to open in Safari (Add to Home Screen is degraded/absent otherwise).

### 4.5 Push reliability handling (iOS-specific)
- iOS web-push subscriptions can silently expire after prolonged app inactivity — a real risk for a reminder app whose users may not open it for days.
- The PWA SHOULD re-validate / re-subscribe the push subscription on app open, and the backend SHOULD tolerate dead subscriptions (detect failed sends, mark stale) rather than assuming a subscription stays valid.

## 5. Non-goals

- **Web Share Target on iOS.** Impossible (WebKit). The Shortcut is the substitute.
- **Silent/background capture on iOS** (no app flash). That needs the token-carrying Shortcut — deferred to §8, demand-driven.
- **A native iOS app / share extension.** True Android-equivalent capture, but costs the Apple Developer fee + App Store review. Deferred to §8, only if InSave earns it.
- **Any backend change.** Capture endpoint, D1, sync, collections, tiers, reminder engine all reused unchanged. This PRD adds an iOS front-door, not new server logic.
- iOS UI redesign (separate frontend effort).

## 6. Acceptance criteria

- [ ] A single universal iCloud Shortcut, carrying no secrets, can be added by tapping a link → Add Shortcut; it appears in the iOS share sheet.
- [ ] Sharing an Instagram reel → tapping the Shortcut opens the PWA and captures the reel into "Saved" via the existing pipeline, attributed to the logged-in user.
- [ ] iOS onboarding routes the user into Safari, shows Add-to-Home-Screen with a screenshot, offers the Shortcut link, and shows the capture gesture.
- [ ] Reminders (cron → Web Push → Done/Snooze) work on a real iPhone with the PWA installed via Safari and permission granted — no engine changes.
- [ ] Clipboard fallback captures a copied reel link without paste, triggered by a user tap.
- [ ] Capture degrades gracefully if the PWA isn't installed/logged-in when the deep link fires (no silent reel loss).
- [ ] Push subscription is re-validated on app open; backend tolerates/marks stale subscriptions.
- [ ] The whole capture path works offline-first, consistent with PRD 01.

## 7. Open questions

- **Shortcut → PWA handoff mechanism:** exact deep-link scheme / URL the Shortcut opens, and how the PWA receives the shared URL on launch. Verify on a real device (Shortcut "Open URLs" / app deep-link behaviour).
- **Does the app-open flash actually bother users?** This determines whether §8's silent upgrade is ever needed. Measure with real iPhone users before building it.
- **Collection chips on deep-link capture:** show the same PRD 05 chip surface, or default-to-Saved-only on iOS to keep the flash brief? Lean: default to Saved, keep it fast; revisit.
- **Onboarding completion / drop-off:** where do iOS users bounce (PWA install vs Shortcut add)? Instrument to find the friction point.
- **Shortcut distribution/versioning:** if the Shortcut ever needs to change (e.g. deep-link scheme update), users must re-add it. Keep the Shortcut as dumb and stable as possible so it rarely changes.

## 8. Demand-driven upgrades (NOT built here — build only if real users need them)

Ordered by feel (and by cost). v1 ships the §2 mechanism; these are conditional, not a committed roadmap:

1. **Token-carrying silent Shortcut** — a per-user Shortcut (minted with the user's capture token at download, while logged in) that POSTs directly to the capture endpoint **without opening the app** (no flash). Cost: per-user token minting, embedding, rotation/revocation, and a personalized (not universal) setup link. Build **only if** the app-open flash demonstrably annoys real iPhone users.
2. **Native iOS app / share extension** — true silent share-sheet capture and no Shortcut setup (real Android-equivalent feel). Cost: $99/yr Apple Developer account, Xcode pipeline, App Store review — everything this project has deliberately avoided. Build **only if** InSave's traction justifies spending money.

Same discipline as the rest of InSave (enrichment stub, deferred auto-sort): do not build the fancier mechanism until the simple one proves insufficient with real users.

---

*Adds: an iOS capture front-door + onboarding. Reuses: all backend, PRD 01 capture pipeline, PRD 05 collections, PRD 04/06 reminders. Parallels: PRD 01 (Android Web Share Target).*
