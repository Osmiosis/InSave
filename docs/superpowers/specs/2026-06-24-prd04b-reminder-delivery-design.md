# PRD 04b — Reminder Delivery (Web Push) — Design Spec

**Date:** 2026-06-24
**Project:** InSave
**Source PRD:** `PRD's/04-reminder-engine.md` (§9.6 Web Push, §6 delivery discipline)
**Depends on:** PRD 04a (the headless engine + cron + `notify` seam + `ReminderRepo` + `user_id`)
**Status:** Locked (implemented)

---

## 1. Purpose

Make the reminders the engine already computes actually **reach the phone**. PRD 04a built the
scheduling brain with the push send stubbed behind an injected `notify(userId, digest)`. This cycle
delivers a real Web Push notification ("N reels worth revisiting") to the user's device — even when
InSave is closed — by registering a push subscription, storing it in D1, and wiring a real sender
into that `notify` seam. The rich review view, device pull/restore, and done/snooze actions are the
next cycle (04c).

## 2. Scope

**In scope (04b):**
- Push-subscription registration from the PWA (notification permission → `pushManager.subscribe`).
- `POST /api/subscribe` + a `push_subscriptions` D1 table (scoped by `user_id`).
- A `PushSender` port with a vetted-library adapter; `makeNotify(repo, sender)` replacing the 04a stub.
- Subscription pruning on a gone (404/410) endpoint.
- Service-worker `push` + `notificationclick` handlers; a minimal "Enable reminders" control.
- VAPID key setup (Worker secrets + a client public-key constant).

**Out of scope (→ 04c):** device-side D1 pull/read-back + reconciliation (reinstall restore), the
review-view UI listing due items, and done/snooze/open actions + their endpoint. **Still deferred:**
account-based multi-device transfer; full onboarding/permission UX (this cycle ships a minimal
enable button, not a guided flow).

## 3. Architecture

Three pieces, one new seam, library isolated to one file:

1. **`PushSender` port** (`worker/push-sender.ts`) — mirrors the `ReminderRepo` pattern:
   ```ts
   export interface PushSubscriptionRecord { endpoint: string; user_id: string; p256dh: string; auth: string; created_at: number; }
   export interface PushSender { send(sub: PushSubscriptionRecord, payload: string): Promise<{ ok: boolean; gone: boolean }>; }
   ```
   The library lives only in the adapter (`worker/web-push-sender.ts`); a 404/410 maps to `gone: true`.

2. **`makeNotify(repo, sender): Notify`** (`worker/notify.ts`) — the real `notify(userId, due)` the
   cron calls. Loads that user's subscriptions, assembles one payload, `send`s to each, and **prunes**
   any subscription returned `gone`. Fully unit-testable with a fake repo + fake sender; replaces the
   04a `console.log` stub in `worker/index.ts`'s `scheduled` handler.

3. **Subscription registration** (device → server): an "Enable reminders" control requests permission,
   subscribes via `pushManager`, and POSTs `{ user_id, subscription }` to `POST /api/subscribe`. The
   service worker shows the notification on `push` and focuses/opens the app on `notificationclick`.

**Data flow:** cron (04a) → `notify` → `makeNotify` loads subscriptions for `user_id` → `PushSender.send`
(library → VAPID-signed, RFC 8291-encrypted) → `fetch(endpoint, init)` → device SW `push` fires with the
app closed → notification shown → tap opens the app. Gone endpoints are deleted.

## 4. Data model

### 4.1 D1 — new table `push_subscriptions` (schema.sql)
```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_user ON push_subscriptions (user_id);
```
`endpoint` is the natural unique key (one per device/push-service). Documented `CREATE TABLE` covers
existing remote DBs. **No IndexedDB change** — the subscription lives in the browser's `pushManager`
and server-side D1; mirroring it locally is YAGNI.

### 4.2 `ReminderRepo` additions (worker/reminder-repo.ts)
- `putSubscription(sub: PushSubscriptionRecord): Promise<void>` — upsert on `endpoint`.
- `listSubscriptions(userId: string): Promise<PushSubscriptionRecord[]>`.
- `deleteSubscription(endpoint: string): Promise<void>`.
The D1 adapter (`worker/d1-reminder-repo.ts`) implements them; the cron-test fake gains them too.

### 4.3 `Env` (worker/index.ts)
Add `VAPID_SUBJECT: string; VAPID_PUBLIC_KEY: string; VAPID_PRIVATE_KEY: string;` (Worker secrets/vars,
not in source).

## 5. Library + adapter

Use **`@block65/webcrypto-web-push`** (v1.x; "works with NodeJS, Cloudflare Workers, Bun and Deno",
Web Crypto-based — verified on npm). It is the project's first Worker-side runtime dependency; it is
isolated entirely within `worker/web-push-sender.ts`, so swapping it (or falling back to hand-rolled
crypto) touches one file.

Adapter (`worker/web-push-sender.ts`):
```ts
import { buildPushPayload, type PushSubscription, type VapidKeys } from "@block65/webcrypto-web-push";
import type { PushSender, PushSubscriptionRecord } from "./push-sender";

export function makeWebPushSender(vapid: VapidKeys): PushSender {
  return {
    async send(sub: PushSubscriptionRecord, payload: string) {
      const subscription: PushSubscription = {
        endpoint: sub.endpoint, expirationTime: null,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      const init = await buildPushPayload({ data: payload, options: { ttl: 60 } }, subscription, vapid);
      const res = await fetch(sub.endpoint, init);
      return { ok: res.ok, gone: res.status === 404 || res.status === 410 };
    },
  };
}
```
The `scheduled` handler builds `vapid` from `env` and calls `makeNotify(makeD1ReminderRepo(env.DB), makeWebPushSender(vapid))`.

## 6. Subscription registration (client)

- **Public key:** `src/push-config.ts` exports `VAPID_PUBLIC_KEY` (a base64url string; not secret) plus
  a `urlBase64ToUint8Array` helper for `applicationServerKey`.
- **Identity accessor:** factor the meta `user_id` mint/read out of `createPendingStore` into a shared
  `getUserId(): Promise<string>` in `src/db.ts` (reads the `meta` `user_id`, minting once if absent);
  `createPendingStore` calls it so behavior is unchanged. The enable flow reuses it.
- **Enable control** (`src/push-enable.ts`, wired from `index.html`): on click →
  `Notification.requestPermission()`; if `"granted"`, `navigator.serviceWorker.ready` →
  `reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` → `getUserId()` →
  `POST /api/subscribe` with `{ user_id, subscription: sub.toJSON() }`.
  Failures are surfaced quietly (button text); never throws to the page.
- **`POST /api/subscribe`** (worker `fetch`, `handleSubscribe`): parse `{ user_id, subscription }`,
  build a `PushSubscriptionRecord` (`endpoint`, `user_id`, `keys.p256dh`, `keys.auth`,
  `created_at = Date.now()`), `repo.putSubscription`. Malformed body → 400. Returns 200 `{ ok: true }`.

## 7. Payload + service worker

- **`assemblePayload(due)`** (pure, `src/reminder/payload.ts` so client + worker can share the shape):
  returns `JSON.stringify({ title: "InSave", body, count })` where `body` is
  `"1 reel worth revisiting"` / `"N reels worth revisiting"` (singular/plural). `makeNotify` calls it.
- **SW `push`** (`src/sw.ts`): `event.waitUntil(self.registration.showNotification(title, { body, tag: "insave-digest", data: { count } }))` — the `tag` collapses repeat digests into one.
- **SW `notificationclick`**: close the notification; focus an existing InSave client if open, else
  `clients.openWindow("/")`. (04c points this at the review view.)
- `tag.html`/review is NOT added here; tapping opens the app root in 04b.

## 8. VAPID / secrets / key generation

- Generate once with `npx web-push generate-vapid-keys` (base64url P-256 public + private).
- **Public key** → `src/push-config.ts` `VAPID_PUBLIC_KEY` (shipped to client; safe to expose). A
  clearly-marked placeholder ships; replacing it is a `docs/manual-verification.md` step.
- **Private key + subject** → Worker secrets: `wrangler secret put VAPID_PRIVATE_KEY`, and
  `VAPID_SUBJECT` (a `mailto:` URL) + `VAPID_PUBLIC_KEY` as vars in `wrangler.toml` `[vars]` (public key
  duplicated server-side because the library's `VapidKeys` wants all three). Documented in
  manual-verification.

## 9. Testing

Node-testable units, TDD (vitest; fake D1 mirroring the `worker-sync`/`cron` test fakes):
- **`assemblePayload`** — count + singular/plural body; valid JSON.
- **`makeNotify`** (fake repo + fake sender): sends the assembled payload to each of a user's
  subscriptions; with zero subscriptions makes no `send` call; prunes (calls `deleteSubscription`) a
  subscription the sender reports `gone`; does not prune a merely-failed (`ok:false, gone:false`) one.
- **`handleSubscribe`** (fake D1): a well-formed body upserts a `PushSubscriptionRecord` with the right
  fields; a malformed body returns 400 and writes nothing.
- **`ReminderRepo` subscription methods** in the cron-test fake (so existing cron tests still compile).
- **Manual / on-device** (`docs/manual-verification.md`): real `npx web-push generate-vapid-keys` +
  secret setup; the enable-reminders permission + subscribe round-trip; the SW `push` +
  `notificationclick` handlers; end-to-end "notification arrives on the phone with the app closed";
  a 410 from a stale endpoint prunes the row. The library adapter (`web-push-sender.ts`) and the SW
  handlers are verified here, not in unit tests (real crypto + push service + DOM).

## 10. Acceptance criteria
- [ ] An installed PWA can enable reminders: permission prompt → `pushManager.subscribe` → row in `push_subscriptions` scoped to the device's `user_id`.
- [ ] The cron's `notify` sends a real Web Push to every subscription of a user with a due digest.
- [ ] A notification ("N reels worth revisiting") arrives on the device even when InSave is closed.
- [ ] Tapping the notification opens/focuses the app.
- [ ] A digest is one notification (the `tag` collapses repeats), consistent with PRD §6 batching.
- [ ] A subscription returning 404/410 on send is pruned from D1; a transient failure is not.
- [ ] `POST /api/subscribe` upserts idempotently on `endpoint` and rejects a malformed body.
- [ ] VAPID private key is a Worker secret, never in source; the public key ships to the client.

## 11. Deferred / open (noted, not built in 04b)
- Review-view UI, device D1 pull/reconciliation, done/snooze/open actions + endpoint → 04c.
- Account-based multi-device transfer; guided onboarding/permission UX.
- Notification action buttons (done/snooze directly on the notification) — depend on 04c's action
  endpoint; 04b's notification is tap-to-open only.
- Re-subscription on browser subscription expiry/rotation beyond delete-on-send-gone (the client
  re-subscribes next time the enable flow runs; automatic silent refresh is a later enhancement).
