# PRD 04b — Reminder Delivery (Web Push) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a real Web Push notification ("N reels worth revisiting") to the user's device when the 04a cron produces a due digest — via push-subscription registration, D1 storage, and a real sender wired into the cron's `notify` seam.

**Architecture:** A `PushSender` port isolates the `@block65/webcrypto-web-push` library to one adapter; `makeNotify(repo, sender)` replaces the 04a stub and is unit-tested against fakes. The device registers a subscription (`POST /api/subscribe` → `push_subscriptions` table); the service worker shows the notification on `push` and opens the app on `notificationclick`. Reminder-state ownership and the cron are unchanged from 04a.

**Tech Stack:** TypeScript, Cloudflare Worker (`fetch` + `scheduled`) + D1, `@block65/webcrypto-web-push` (Web Crypto, Workers-compatible), Web Push API + service worker, `idb`, vitest.

## Global Constraints

- `@block65/webcrypto-web-push` is the only new runtime dependency and is imported ONLY in `worker/web-push-sender.ts` (the library adapter). Everything else stays library-agnostic behind the `PushSender` port.
- VAPID private key is a Worker secret (`VAPID_PRIVATE_KEY`), never committed. The public key is non-secret (client constant + `wrangler.toml` var).
- Reminder-state columns stay cron-owned (04a); 04b adds only the `push_subscriptions` table and a `/api/subscribe` write path. No IndexedDB schema change.
- Pure/logic modules are unit-tested (vitest); the library adapter, the service-worker `push`/`notificationclick` handlers, and the client enable flow are verified via `docs/manual-verification.md` (real crypto + push service + DOM).
- Tests live in `tests/`. Run `npx vitest run`; type-check + build `npm run build` (`tsc && vite build`).
- `PushSubscriptionRecord` shape: `{ endpoint: string; user_id: string; p256dh: string; auth: string; created_at: number }`.

---

### Task 1: `assemblePayload` (pure)

**Files:**
- Create: `src/reminder/payload.ts`
- Test: `tests/reminder/payload.test.ts`

**Interfaces:**
- Consumes: `PendingCapture`.
- Produces: `assemblePayload(due: PendingCapture[]): string` — a JSON string `{ title, body, count }`.

- [ ] **Step 1: Write the failing test**

Create `tests/reminder/payload.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assemblePayload } from "../../src/reminder/payload";
import type { PendingCapture } from "../../src/types";

function item(id: string): PendingCapture {
  return {
    id, canonical_url: "u", raw_payload: "{}", captured_at: 0,
    source: "import", status: "tagged", parse_ok: true, synced: true,
  };
}

describe("assemblePayload", () => {
  it("uses a singular body for one item", () => {
    const p = JSON.parse(assemblePayload([item("a")]));
    expect(p).toEqual({ title: "InSave", body: "1 reel worth revisiting", count: 1 });
  });

  it("uses a plural body for several items", () => {
    const p = JSON.parse(assemblePayload([item("a"), item("b"), item("c")]));
    expect(p.body).toBe("3 reels worth revisiting");
    expect(p.count).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/reminder/payload.test.ts`
Expected: FAIL — cannot find module `../../src/reminder/payload`.

- [ ] **Step 3: Implement `src/reminder/payload.ts`**

```ts
import type { PendingCapture } from "../types";

// Shared notification payload shape (worker builds it; the service worker renders it).
export function assemblePayload(due: PendingCapture[]): string {
  const count = due.length;
  const body = count === 1 ? "1 reel worth revisiting" : `${count} reels worth revisiting`;
  return JSON.stringify({ title: "InSave", body, count });
}
```

- [ ] **Step 4: Run the test + type-check**

Run: `npx vitest run tests/reminder/payload.test.ts` then `npx tsc --noEmit`
Expected: PASS (2 tests); no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/reminder/payload.ts tests/reminder/payload.test.ts
git commit -m "feat: assemblePayload for push digest (PRD 04b)"
```

---

### Task 2: PushSender port + subscription repo + `makeNotify`

**Files:**
- Create: `worker/push-sender.ts`
- Create: `worker/notify.ts`
- Modify: `worker/reminder-repo.ts`
- Modify: `worker/d1-reminder-repo.ts`
- Modify: `schema.sql`
- Modify: `tests/reminder/cron.test.ts` (fake repo gains the 3 subscription methods)
- Test: `tests/reminder/notify.test.ts`

**Interfaces:**
- Consumes: `assemblePayload` (Task 1); `Notify` (from `worker/cron.ts`, 04a); `ReminderRepo` (04a).
- Produces: `PushSubscriptionRecord`, `PushSender` (`worker/push-sender.ts`); `ReminderRepo` gains `putSubscription(sub)`, `listSubscriptions(userId)`, `deleteSubscription(endpoint)`; `makeNotify(repo, sender): Notify` (`worker/notify.ts`); `push_subscriptions` D1 table.

- [ ] **Step 1: Define the port in `worker/push-sender.ts`**

```ts
export interface PushSubscriptionRecord {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
  created_at: number;
}

export interface PushSender {
  // Sends one encrypted push. `gone` means the endpoint is dead (404/410) and should be pruned.
  send(sub: PushSubscriptionRecord, payload: string): Promise<{ ok: boolean; gone: boolean }>;
}
```

- [ ] **Step 2: Extend the `ReminderRepo` interface in `worker/reminder-repo.ts`**

Add the import at the top:

```ts
import type { PushSubscriptionRecord } from "./push-sender";
```

Add these three methods to the `ReminderRepo` interface (after `writeReminderState`):

```ts
  putSubscription(sub: PushSubscriptionRecord): Promise<void>;
  listSubscriptions(userId: string): Promise<PushSubscriptionRecord[]>;
  deleteSubscription(endpoint: string): Promise<void>;
```

- [ ] **Step 3: Implement the three methods in `worker/d1-reminder-repo.ts`**

Add the import at the top:

```ts
import type { PushSubscriptionRecord } from "./push-sender";
```

Add these methods inside the returned object (after `writeReminderState`):

```ts
    async putSubscription(sub) {
      await db
        .prepare(
          `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET
             user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
        )
        .bind(sub.endpoint, sub.user_id, sub.p256dh, sub.auth, sub.created_at)
        .run();
    },

    async listSubscriptions(userId) {
      const { results } = await db
        .prepare(`SELECT * FROM push_subscriptions WHERE user_id = ?`)
        .bind(userId)
        .all<PushSubscriptionRecord>();
      return results ?? [];
    },

    async deleteSubscription(endpoint) {
      await db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(endpoint).run();
    },
```

- [ ] **Step 4: Add the `push_subscriptions` table to `schema.sql`**

Append to the end of the file:

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

- [ ] **Step 5: Update the cron-test fake repo so it still satisfies `ReminderRepo`**

In `tests/reminder/cron.test.ts`, inside the `repo: ReminderRepo = { ... }` object in `fakeRepo`, add these three methods (after `writeReminderState`):

```ts
    async putSubscription() {},
    async listSubscriptions() { return []; },
    async deleteSubscription() {},
```

- [ ] **Step 6: Write the failing `makeNotify` test**

Create `tests/reminder/notify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeNotify } from "../../worker/notify";
import type { ReminderRepo } from "../../worker/reminder-repo";
import type { PushSender, PushSubscriptionRecord } from "../../worker/push-sender";
import type { PendingCapture } from "../../src/types";

function sub(endpoint: string): PushSubscriptionRecord {
  return { endpoint, user_id: "u1", p256dh: "p", auth: "a", created_at: 0 };
}

function due(): PendingCapture[] {
  return [{
    id: "i", canonical_url: "u", raw_payload: "{}", captured_at: 0,
    source: "import", status: "tagged", parse_ok: true, synced: true,
  }];
}

function fakes(subs: PushSubscriptionRecord[], goneEndpoints: string[] = []) {
  const deleted: string[] = [];
  const sentTo: string[] = [];
  const repo = {
    async listSubscriptions(_u: string) { return subs; },
    async deleteSubscription(endpoint: string) { deleted.push(endpoint); },
  } as unknown as ReminderRepo;
  const sender: PushSender = {
    async send(s, _payload) { sentTo.push(s.endpoint); return { ok: !goneEndpoints.includes(s.endpoint), gone: goneEndpoints.includes(s.endpoint) }; },
  };
  return { repo, sender, deleted, sentTo };
}

describe("makeNotify", () => {
  it("sends the digest to each of the user's subscriptions", async () => {
    const { repo, sender, sentTo } = fakes([sub("e1"), sub("e2")]);
    await makeNotify(repo, sender)("u1", due());
    expect(sentTo.sort()).toEqual(["e1", "e2"]);
  });

  it("makes no send when the user has no subscriptions", async () => {
    const { repo, sender, sentTo } = fakes([]);
    await makeNotify(repo, sender)("u1", due());
    expect(sentTo).toEqual([]);
  });

  it("prunes a subscription the sender reports gone", async () => {
    const { repo, sender, deleted } = fakes([sub("e1"), sub("e2")], ["e2"]);
    await makeNotify(repo, sender)("u1", due());
    expect(deleted).toEqual(["e2"]);
  });

  it("does not prune a merely-failed (not gone) subscription", async () => {
    const { repo, sender, deleted } = fakes([sub("e1")]);
    const failing: PushSender = { async send() { return { ok: false, gone: false }; } };
    await makeNotify(repo, failing)("u1", due());
    expect(deleted).toEqual([]);
    void sender;
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx vitest run tests/reminder/notify.test.ts`
Expected: FAIL — cannot find module `../../worker/notify`.

- [ ] **Step 8: Implement `worker/notify.ts`**

```ts
import { assemblePayload } from "../src/reminder/payload";
import type { Notify } from "./cron";
import type { ReminderRepo } from "./reminder-repo";
import type { PushSender } from "./push-sender";

export function makeNotify(repo: ReminderRepo, sender: PushSender): Notify {
  return async (userId, due) => {
    const subs = await repo.listSubscriptions(userId);
    if (subs.length === 0) return;
    const payload = assemblePayload(due);
    for (const sub of subs) {
      const res = await sender.send(sub, payload);
      if (res.gone) await repo.deleteSubscription(sub.endpoint);
    }
  };
}
```

- [ ] **Step 9: Run tests + type-check**

Run: `npx vitest run` then `npx tsc --noEmit`
Expected: all pass (the 4 notify cases + the updated cron tests still green); no type errors.

- [ ] **Step 10: Commit**

```bash
git add worker/push-sender.ts worker/notify.ts worker/reminder-repo.ts worker/d1-reminder-repo.ts schema.sql tests/reminder/cron.test.ts tests/reminder/notify.test.ts
git commit -m "feat: PushSender port + subscription repo + makeNotify (PRD 04b)"
```

---

### Task 3: Library adapter + `/api/subscribe` + wire the real sender

**Files:**
- Install: `@block65/webcrypto-web-push`
- Create: `worker/web-push-sender.ts`
- Modify: `worker/index.ts`
- Modify: `wrangler.toml`
- Test: `tests/worker-subscribe.test.ts`

**Interfaces:**
- Consumes: `PushSender`/`PushSubscriptionRecord` (Task 2), `makeNotify` (Task 2), `makeD1ReminderRepo` (04a), `runCron` (04a).
- Produces: `makeWebPushSender(vapid): PushSender`; `Env` gains the three VAPID fields; `parseSubscribe(body, now): PushSubscriptionRecord | null` + a `POST /api/subscribe` route; the `scheduled` handler now sends real pushes.

- [ ] **Step 1: Install the library**

Run: `npm install @block65/webcrypto-web-push`
Expected: it is added to `dependencies` in `package.json`.

- [ ] **Step 2: Write the failing subscribe-parse test**

Create `tests/worker-subscribe.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseSubscribe } from "../worker/index";

const good = {
  user_id: "u1",
  subscription: { endpoint: "https://push.example/abc", keys: { p256dh: "PKEY", auth: "AKEY" } },
};

describe("parseSubscribe", () => {
  it("builds a PushSubscriptionRecord from a well-formed body", () => {
    expect(parseSubscribe(good, 1234)).toEqual({
      endpoint: "https://push.example/abc", user_id: "u1", p256dh: "PKEY", auth: "AKEY", created_at: 1234,
    });
  });

  it("returns null when required fields are missing", () => {
    expect(parseSubscribe({ user_id: "u1" }, 0)).toBeNull();
    expect(parseSubscribe({ subscription: good.subscription }, 0)).toBeNull();
    expect(parseSubscribe({ user_id: "u1", subscription: { endpoint: "e", keys: {} } }, 0)).toBeNull();
    expect(parseSubscribe(null, 0)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/worker-subscribe.test.ts`
Expected: FAIL — `parseSubscribe` is not exported from `worker/index`.

- [ ] **Step 4: Implement the library adapter `worker/web-push-sender.ts`**

```ts
import { buildPushPayload, type PushSubscription, type VapidKeys } from "@block65/webcrypto-web-push";
import type { PushSender, PushSubscriptionRecord } from "./push-sender";

// The ONLY file that touches the web-push library. Maps a dead endpoint (404/410) to `gone`.
export function makeWebPushSender(vapid: VapidKeys): PushSender {
  return {
    async send(sub: PushSubscriptionRecord, payload: string) {
      const subscription: PushSubscription = {
        endpoint: sub.endpoint,
        expirationTime: null,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      const init = await buildPushPayload({ data: payload, options: { ttl: 60 } }, subscription, vapid);
      const res = await fetch(sub.endpoint, init);
      return { ok: res.ok, gone: res.status === 404 || res.status === 410 };
    },
  };
}
```

- [ ] **Step 5: Wire `worker/index.ts` — Env, `parseSubscribe`, `/api/subscribe`, real `notify`**

Add imports at the top (after the existing two):

```ts
import { makeNotify } from "./notify";
import { makeWebPushSender } from "./web-push-sender";
import type { PushSubscriptionRecord } from "./push-sender";
```

Replace the `Env` interface with:

```ts
interface Env {
  DB: D1Database;
  VAPID_SUBJECT: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
}
```

Add the exported parser (near `toBind`):

```ts
export function parseSubscribe(body: unknown, now: number): PushSubscriptionRecord | null {
  const b = body as { user_id?: unknown; subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } } | null;
  const user_id = b?.user_id;
  const endpoint = b?.subscription?.endpoint;
  const p256dh = b?.subscription?.keys?.p256dh;
  const auth = b?.subscription?.keys?.auth;
  if (typeof user_id !== "string" || typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") {
    return null;
  }
  return { endpoint, user_id, p256dh, auth, created_at: now };
}
```

Add a route inside `fetch` (before the `return new Response("Not found"...)`):

```ts
    if (request.method === "POST" && url.pathname === "/api/subscribe") {
      return handleSubscribe(request, env);
    }
```

Replace the `scheduled` handler body with the real sender:

```ts
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const repo = makeD1ReminderRepo(env.DB);
    const sender = makeWebPushSender({
      subject: env.VAPID_SUBJECT,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    });
    await runCron(repo, Date.now(), makeNotify(repo, sender));
  },
```

Add the handler function at the bottom of the file (after `handleSync`):

```ts
async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad payload" }), { status: 400 });
  }
  const record = parseSubscribe(body, Date.now());
  if (!record) {
    return new Response(JSON.stringify({ error: "bad payload" }), { status: 400 });
  }
  await makeD1ReminderRepo(env.DB).putSubscription(record);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
```

- [ ] **Step 6: Add VAPID vars to `wrangler.toml`**

Append to the end of the file:

```toml
[vars]
VAPID_SUBJECT = "mailto:REPLACE_WITH_CONTACT_EMAIL"
VAPID_PUBLIC_KEY = "REPLACE_WITH_VAPID_PUBLIC_KEY"
# VAPID_PRIVATE_KEY is set via: wrangler secret put VAPID_PRIVATE_KEY
```

- [ ] **Step 7: Run tests + type-check + build**

Run: `npx vitest run` then `npm run build`
Expected: all tests pass (incl. the 2 `parseSubscribe` cases); `tsc` clean (the library resolves under `moduleResolution: bundler`); Vite build succeeds. (The library adapter + real send are exercised on-device, not in unit tests.)

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json worker/web-push-sender.ts worker/index.ts wrangler.toml tests/worker-subscribe.test.ts
git commit -m "feat: web-push library adapter + /api/subscribe + real cron sender (PRD 04b)"
```

---

### Task 4: `getUserId` + client enable flow + service-worker push handlers

**Files:**
- Modify: `src/db.ts`
- Modify: `src/pending-store.ts`
- Create: `src/push-config.ts`
- Create: `src/push-enable.ts`
- Modify: `index.html`
- Modify: `src/sw.ts`
- Test: `tests/db.test.ts` (add a `getUserId` case)

**Interfaces:**
- Consumes: `META_STORE`, `openInsaveDB` (04a).
- Produces: `getUserId(uuid?): Promise<string>` (`src/db.ts`); `VAPID_PUBLIC_KEY` + `urlBase64ToUint8Array` (`src/push-config.ts`); the enable flow (`src/push-enable.ts`); SW `push`/`notificationclick` handlers.

- [ ] **Step 1: Add `getUserId` to `src/db.ts`**

Append after `openInsaveDB`:

```ts
// Reads (or mints once) the device's own user_id from the meta store. Shared by the
// pending-store and the push-enable flow so both agree on identity.
export async function getUserId(uuid: () => string = () => crypto.randomUUID()): Promise<string> {
  const db = await openInsaveDB();
  const meta = (await db.get(META_STORE, "user_id")) as { key: string; value: string } | undefined;
  if (meta) return meta.value;
  const value = uuid();
  await db.put(META_STORE, { key: "user_id", value });
  return value;
}
```

- [ ] **Step 2: Make `createPendingStore` use `getUserId` in `src/pending-store.ts`**

Change the import line to add `getUserId`:

```ts
import { openInsaveDB, PENDING_STORE, META_STORE, getUserId } from "./db";
```

Replace the mint/backfill block (the `let meta = ... const userId = meta.value;` section) with:

```ts
  // user_id is owned by getUserId (shared with push-enable). Backfill pre-existing
  // records only on the very first mint (when no user_id existed yet).
  const hadUserId = Boolean(await db.get(META_STORE, "user_id"));
  const userId = await getUserId(uuid);
  if (!hadUserId) {
    const tx = db.transaction(PENDING_STORE, "readwrite");
    let cursor = await tx.store.openCursor();
    while (cursor) {
      const r = cursor.value as PendingCapture;
      if (!r.user_id) await cursor.update({ ...r, user_id: userId, synced: false });
      cursor = await cursor.continue();
    }
    await tx.done;
  }
```

- [ ] **Step 3: Write the failing `getUserId` test**

Add this case inside the `describe("db schema", ...)` block in `tests/db.test.ts` (before its closing `});`):

```ts
  it("getUserId mints once and returns the same id thereafter", async () => {
    const first = await getUserId(() => "minted-id");
    const second = await getUserId(() => "different-id");
    expect(first).toBe("minted-id");
    expect(second).toBe("minted-id"); // already minted; uuid fn ignored
  });
```

Add `getUserId` to the existing import from `../src/db` at the top of the file:

```ts
import { openInsaveDB, PENDING_STORE, getUserId } from "../src/db";
```

- [ ] **Step 4: Run tests to verify the new one passes and identity tests still hold**

Run: `npx vitest run tests/db.test.ts tests/pending-store.test.ts`
Expected: PASS (the new `getUserId` case + the existing v4 + identity cases).

- [ ] **Step 5: Create `src/push-config.ts`**

```ts
// VAPID public key is NOT secret — it ships to the client as the applicationServerKey.
// Generate with `npx web-push generate-vapid-keys`; replace the placeholder below and
// the matching VAPID_PUBLIC_KEY in wrangler.toml.
export const VAPID_PUBLIC_KEY = "REPLACE_WITH_VAPID_PUBLIC_KEY";

export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) arr[i] = raw.charCodeAt(i);
  return arr;
}
```

- [ ] **Step 6: Create `src/push-enable.ts`**

```ts
import { VAPID_PUBLIC_KEY, urlBase64ToUint8Array } from "./push-config";
import { getUserId } from "./db";

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
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    const user_id = await getUserId();
    await fetch("/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id, subscription: sub.toJSON() }),
    });
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

- [ ] **Step 7: Add the enable button to `index.html`**

After the `<p><a href="/tag.html" ...>Tag your queue →</a></p>` line, add:

```html
      <p><button id="enable-reminders">Enable reminders</button></p>
```

Before the existing `<script type="module" src="/src/register-sw.ts"></script>` line, add:

```html
    <script type="module" src="/src/push-enable.ts"></script>
```

- [ ] **Step 8: Add `push` + `notificationclick` handlers to `src/sw.ts`**

Add these two listeners at the end of the file (after `handleShare`'s definition, at top level):

```ts
self.addEventListener("push", (event: PushEvent) => {
  let data = { title: "InSave", body: "Saved reels worth revisiting", count: 0 };
  try {
    if (event.data) data = { ...data, ...(event.data.json() as Partial<typeof data>) };
  } catch {
    /* malformed payload — fall back to the default copy */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: "insave-digest", // collapse repeat digests into one
      data,
    }),
  );
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((c) => "focus" in c);
      if (existing) {
        await existing.focus();
        return;
      }
      await self.clients.openWindow("/");
    })(),
  );
});
```

- [ ] **Step 9: Type-check + build**

Run: `npx tsc --noEmit` then `npm run build`
Expected: no type errors (the SW `PushEvent`/`NotificationEvent` resolve from the `WebWorker` lib already in `tsconfig`); Vite build succeeds and emits the `push-enable` module as part of `index.html`. (The enable flow + SW handlers are verified on-device.)

- [ ] **Step 10: Commit**

```bash
git add src/db.ts src/pending-store.ts src/push-config.ts src/push-enable.ts index.html src/sw.ts tests/db.test.ts
git commit -m "feat: getUserId + enable-reminders flow + SW push handlers (PRD 04b)"
```

---

### Task 5: Manual-verification doc + notes.md summary + lock spec

**Files:**
- Modify: `docs/manual-verification.md`
- Modify: `notes.md`
- Modify: `docs/superpowers/specs/2026-06-24-prd04b-reminder-delivery-design.md:8`

**Interfaces:**
- Consumes: the completed implementation.
- Produces: the manual checklist, the chronological PRD 04b summary, and a locked spec.

- [ ] **Step 1: Full verification gate**

Run: `npx vitest run` then `npm run build`
Expected: all tests green (record the count); `tsc` clean; build succeeds. Do NOT write the summary until this passes.

- [ ] **Step 2: Append the PRD 04b manual-verification section to `docs/manual-verification.md`**

```markdown

## PRD 04b — Reminder Delivery (Web Push)

### Setup
- Generate VAPID keys once: `npx web-push generate-vapid-keys`.
- Put the **public** key in `src/push-config.ts` (`VAPID_PUBLIC_KEY`) and `wrangler.toml` `[vars]`;
  set the **private** key as a secret: `wrangler secret put VAPID_PRIVATE_KEY`; set `VAPID_SUBJECT`
  to a real `mailto:` in `wrangler.toml`.
- Create the subscriptions table: re-run `schema.sql` (its `CREATE TABLE IF NOT EXISTS` is safe), or for
  an existing remote DB run the `CREATE TABLE push_subscriptions ...` + `idx_subs_user` statements.

### Checklist
- [ ] On the installed PWA, tap "Enable reminders" → permission prompt → a row appears in `push_subscriptions` for the device's `user_id` (`SELECT * FROM push_subscriptions`).
- [ ] Make an item due and trigger the cron (`wrangler dev --test-scheduled` + `curl ".../__scheduled"`): a single notification "N reels worth revisiting" arrives — with InSave fully closed.
- [ ] Tapping the notification opens/focuses InSave.
- [ ] Two due items in one cycle still produce ONE notification (the `insave-digest` tag collapses it).
- [ ] Unsubscribe in the browser (or use a stale endpoint) then trigger the cron → the dead row is pruned from `push_subscriptions` (404/410 → delete).
- [ ] The VAPID private key is only a Worker secret (not in the repo); `git grep` finds no private key.
```

- [ ] **Step 3: Append the PRD 04b summary to `notes.md`**

Append a new `## PRD 04b — Reminder Delivery (Web Push) — 2026-06-24` section, same structure as the existing entries (What it is / Decisions made / How it works / Delivered (verified, with the real final test count + files from Step 1) / Still manual / open / Artifacts / Next PRDs). Under "Still manual / open" list: the VAPID keygen + secret setup, the on-device push round-trip, and that 04c brings the review UI + device pull + done/snooze actions. Reference the spec and this plan under Artifacts. Set Next to "04c Reminder Interaction (review UI + device pull + done/snooze)".

- [ ] **Step 4: Lock the design spec**

In `docs/superpowers/specs/2026-06-24-prd04b-reminder-delivery-design.md`, change line 8 `**Status:** Approved for planning` → `**Status:** Locked (implemented)`.

- [ ] **Step 5: Commit**

```bash
git add docs/manual-verification.md notes.md docs/superpowers/specs/2026-06-24-prd04b-reminder-delivery-design.md
git commit -m "docs: PRD 04b manual checklist + notes summary + lock spec"
```

---

## Self-Review notes (plan vs. spec)

- **Spec §3 PushSender seam + makeNotify** → Task 2 (port + `makeNotify` + fakes) + Task 3 (real adapter wired into `scheduled`).
- **§4.1 push_subscriptions table** → Task 2 (schema). **§4.2 repo methods** → Task 2 (interface + D1 impl + fake). **§4.3 Env VAPID** → Task 3.
- **§5 library + adapter (exact `buildPushPayload` → `fetch` shape, 404/410 → gone)** → Task 3 (`web-push-sender.ts`).
- **§6 registration (getUserId, enable control, /api/subscribe, parseSubscribe)** → Task 4 (`getUserId`, `push-enable`, `push-config`) + Task 3 (`parseSubscribe` + route).
- **§7 payload + SW handlers** → Task 1 (`assemblePayload`) + Task 4 (SW `push`/`notificationclick`).
- **§8 VAPID/secrets/keygen** → Task 3 (`wrangler.toml` vars + secret note) + Task 5 (manual setup).
- **§9 testing** → payload (T1), makeNotify (T2), parseSubscribe (T3), getUserId (T4); manual checklist (T5) covers the library adapter, SW handlers, enable flow, end-to-end.
- **§10 acceptance criteria** → covered across Tasks 1–4 + the manual checklist (T5).
- **Type/name consistency:** `PushSubscriptionRecord` (push-sender.ts) used identically in reminder-repo, d1-reminder-repo, notify, index, and tests. `PushSender.send(sub, payload) => {ok, gone}` identical in port, adapter, fakes. `makeNotify(repo, sender): Notify` returns the 04a `Notify` type. `parseSubscribe(body, now)` index export matches its test. `getUserId(uuid?)` identical in db.ts, pending-store, push-enable, and the test. Library API `buildPushPayload(message, subscription, vapid)` + `VapidKeys{subject,publicKey,privateKey}` matches the verified README.
- **No placeholders** (other than the intentional VAPID `REPLACE_WITH_*` values, which are documented setup steps): every code step has complete code; commands have expected output.
