# PRD01 Capture + Share Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the InSave capture fast path — an installed Android PWA that registers in Instagram's share sheet, persists a shared reel to a durable local pending queue sub-second, releases the user, and syncs to Cloudflare D1.

**Architecture:** Plain Vite + TypeScript static app on Cloudflare Pages. A service worker intercepts the `share_target` POST, does parse→normalize→dedupe→persist against IndexedDB, then 303-redirects to a toast page. A Cloudflare Worker (`/api/sync`) upserts records into D1 idempotently. Sync drains on `online` events and SW activation. No tagging/enrichment/reminders.

**Tech Stack:** Vite, TypeScript, Vitest, `fake-indexeddb` (test), `idb` (IndexedDB wrapper), Cloudflare Pages + Workers + D1, Wrangler.

---

## File Structure

```
src/
  types.ts            # shared TS types (PendingCapture, SharePayload, CaptureResult)
  url-normalize.ts    # pure: extractReelUrl, canonicalize, parse
  pending-store.ts    # IndexedDB wrapper (idb): put/getByCanonicalUrl/listUnsynced/markSynced
  capture.ts          # orchestration: handleCapture(payload, store)
  sync.ts             # drainSync(store, fetchFn): batch-post unsynced to /api/sync
  sw.ts               # service worker: precache + /share fetch handler + sync triggers
  captured.ts         # toast UI for /captured page
public/
  index.html          # app shell / install landing
  captured.html       # capture confirmation page (loads captured.ts)
  manifest.webmanifest # share_target + install metadata
  icons/icon-192.png, icon-512.png
worker/
  index.ts            # Cloudflare Worker: POST /api/sync -> D1 upsert
schema.sql            # D1 pending_capture table
tests/
  url-normalize.test.ts
  capture.test.ts
  pending-store.test.ts
  sync.test.ts
package.json  tsconfig.json  vite.config.ts  vitest.config.ts  wrangler.toml
docs/manual-verification.md
```

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `.gitignore` (exists — verify)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "insave",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "worker:dev": "wrangler dev",
    "db:init": "wrangler d1 execute insave --local --file=schema.sql"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "vitest": "^2.0.0",
    "fake-indexeddb": "^6.0.0",
    "wrangler": "^3.78.0"
  },
  "dependencies": {
    "idb": "^8.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2020", "DOM", "DOM.Iterable", "WebWorker"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src", "worker", "tests"]
}
```

- [ ] **Step 3: Create `vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "public/index.html"),
        captured: resolve(__dirname, "public/captured.html"),
      },
    },
  },
});
```

- [ ] **Step 4: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Install deps**

Run: `npm install`
Expected: completes, `node_modules/` populated, no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vite.config.ts vitest.config.ts package-lock.json
git commit -m "chore: scaffold Vite + TS + Vitest project"
```

---

## Task 2: Shared types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write `src/types.ts`**

```typescript
export interface SharePayload {
  url?: string;
  text?: string;
  title?: string;
}

export type CaptureSource = "share_target" | "import" | "shortcut" | "clipboard";
export type CaptureStatus = "pending";

export interface PendingCapture {
  id: string;            // client-generated UUID
  canonical_url: string; // dedupe key ("" when parse_ok is false and no URL recovered)
  raw_payload: string;   // JSON.stringify of the original SharePayload
  captured_at: number;   // epoch ms
  source: CaptureSource;
  status: CaptureStatus;
  parse_ok: boolean;
  synced: boolean;       // local-only flag, not sent to backend as a column
}

export type CaptureOutcome = "saved" | "dup" | "unparsed" | "error";

export interface CaptureResult {
  status: CaptureOutcome;
  record?: PendingCapture;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat: shared capture types"
```

---

## Task 3: URL normalization (pure functions, TDD)

**Files:**
- Create: `src/url-normalize.ts`
- Test: `tests/url-normalize.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/url-normalize.test.ts
import { describe, it, expect } from "vitest";
import { extractReelUrl, canonicalize, parse } from "../src/url-normalize";

describe("extractReelUrl", () => {
  it("returns the url field when it is an instagram reel", () => {
    expect(extractReelUrl({ url: "https://www.instagram.com/reel/ABC123/" }))
      .toBe("https://www.instagram.com/reel/ABC123/");
  });

  it("recovers a reel url embedded in the text field", () => {
    expect(extractReelUrl({ text: "Check this https://www.instagram.com/reel/ABC123/?igsh=xyz out" }))
      .toBe("https://www.instagram.com/reel/ABC123/?igsh=xyz");
  });

  it("recovers a share-link variant (instagram.com/reels/)", () => {
    expect(extractReelUrl({ text: "https://instagram.com/reels/ABC123" }))
      .toBe("https://instagram.com/reels/ABC123");
  });

  it("returns null when no instagram url is present", () => {
    expect(extractReelUrl({ text: "just some words", title: "nope" })).toBeNull();
  });
});

describe("canonicalize", () => {
  it("strips tracking params and trailing slash differences to one key", () => {
    const a = canonicalize("https://www.instagram.com/reel/ABC123/?igsh=xyz&utm_source=ig");
    const b = canonicalize("https://instagram.com/reel/ABC123");
    expect(a).toBe(b);
  });

  it("normalizes /reels/ variant to /reel/", () => {
    expect(canonicalize("https://www.instagram.com/reels/ABC123/"))
      .toBe("https://www.instagram.com/reel/ABC123");
  });
});

describe("parse", () => {
  it("returns canonical url and parseOk=true for a valid reel", () => {
    expect(parse({ url: "https://www.instagram.com/reel/ABC123/?igsh=x" }))
      .toEqual({ canonicalUrl: "https://www.instagram.com/reel/ABC123", parseOk: true });
  });

  it("returns parseOk=false and empty canonical url when nothing usable", () => {
    expect(parse({ text: "garbage" })).toEqual({ canonicalUrl: "", parseOk: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/url-normalize.test.ts`
Expected: FAIL — cannot resolve `../src/url-normalize`.

- [ ] **Step 3: Implement `src/url-normalize.ts`**

```typescript
import type { SharePayload } from "./types";

const TRACKING_PARAMS = [/^igsh$/i, /^igshid$/i, /^utm_/i, /^fbclid$/i, /^__/];
const INSTAGRAM_HOST = /(^|\.)instagram\.com$/i;
// matches /reel/, /reels/, /p/ shortcodes
const REEL_URL_RE = /https?:\/\/(?:www\.)?instagram\.com\/(?:reels?|p)\/[A-Za-z0-9_-]+\/?(?:\?[^\s]*)?/i;

export function extractReelUrl(payload: SharePayload): string | null {
  for (const field of [payload.url, payload.text, payload.title]) {
    if (!field) continue;
    const trimmed = field.trim();
    // whole-field url
    try {
      const u = new URL(trimmed);
      if (INSTAGRAM_HOST.test(u.hostname) && /\/(reels?|p)\//i.test(u.pathname)) {
        return trimmed;
      }
    } catch { /* not a bare url, fall through to regex */ }
    // embedded url
    const m = trimmed.match(REEL_URL_RE);
    if (m) return m[0];
  }
  return null;
}

export function canonicalize(rawUrl: string): string {
  const u = new URL(rawUrl);
  u.hostname = "www.instagram.com";
  u.protocol = "https:";
  u.hash = "";
  // strip tracking params
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) u.searchParams.delete(key);
  }
  // normalize /reels/ -> /reel/
  u.pathname = u.pathname.replace(/\/reels\//i, "/reel/");
  // drop trailing slash
  u.pathname = u.pathname.replace(/\/+$/, "");
  const qs = u.searchParams.toString();
  return `${u.protocol}//${u.hostname}${u.pathname}${qs ? `?${qs}` : ""}`;
}

export function parse(payload: SharePayload): { canonicalUrl: string; parseOk: boolean } {
  const raw = extractReelUrl(payload);
  if (!raw) return { canonicalUrl: "", parseOk: false };
  try {
    return { canonicalUrl: canonicalize(raw), parseOk: true };
  } catch {
    return { canonicalUrl: "", parseOk: false };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/url-normalize.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/url-normalize.ts tests/url-normalize.test.ts
git commit -m "feat: instagram reel url extraction + canonicalization"
```

---

## Task 4: Pending store (IndexedDB wrapper, TDD with fake-indexeddb)

**Files:**
- Create: `src/pending-store.ts`
- Test: `tests/pending-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/pending-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { indexedDB } from "fake-indexeddb";
import { createPendingStore } from "../src/pending-store";
import type { PendingCapture } from "../src/types";

function rec(over: Partial<PendingCapture> = {}): PendingCapture {
  return {
    id: over.id ?? "id-1",
    canonical_url: over.canonical_url ?? "https://www.instagram.com/reel/ABC123",
    raw_payload: "{}",
    captured_at: 1000,
    source: "share_target",
    status: "pending",
    parse_ok: true,
    synced: false,
    ...over,
  };
}

describe("pending-store", () => {
  beforeEach(async () => {
    await new Promise<void>((res) => {
      const del = indexedDB.deleteDatabase("insave");
      del.onsuccess = () => res();
      del.onerror = () => res();
    });
  });

  it("puts and finds by canonical url", async () => {
    const store = await createPendingStore();
    await store.put(rec());
    const found = await store.getByCanonicalUrl("https://www.instagram.com/reel/ABC123");
    expect(found?.id).toBe("id-1");
  });

  it("returns undefined for unknown canonical url", async () => {
    const store = await createPendingStore();
    expect(await store.getByCanonicalUrl("https://www.instagram.com/reel/NOPE")).toBeUndefined();
  });

  it("lists only unsynced records", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a", synced: false }));
    await store.put(rec({ id: "b", canonical_url: "u-b", synced: true }));
    const unsynced = await store.listUnsynced();
    expect(unsynced.map((r) => r.id)).toEqual(["a"]);
  });

  it("marks records synced", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a", synced: false }));
    await store.markSynced(["a"]);
    expect(await store.listUnsynced()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pending-store.test.ts`
Expected: FAIL — cannot resolve `../src/pending-store`.

- [ ] **Step 3: Implement `src/pending-store.ts`**

```typescript
import { openDB, type IDBPDatabase } from "idb";
import type { PendingCapture } from "./types";

const DB_NAME = "insave";
const STORE = "pending_capture";

export interface PendingStore {
  put(record: PendingCapture): Promise<void>;
  getByCanonicalUrl(canonicalUrl: string): Promise<PendingCapture | undefined>;
  listUnsynced(): Promise<PendingCapture[]>;
  markSynced(ids: string[]): Promise<void>;
}

export async function createPendingStore(): Promise<PendingStore> {
  const db: IDBPDatabase = await openDB(DB_NAME, 1, {
    upgrade(database) {
      const os = database.createObjectStore(STORE, { keyPath: "id" });
      os.createIndex("by_canonical_url", "canonical_url", { unique: false });
    },
  });

  return {
    async put(record) {
      await db.put(STORE, record);
    },
    async getByCanonicalUrl(canonicalUrl) {
      if (!canonicalUrl) return undefined;
      return db.getFromIndex(STORE, "by_canonical_url", canonicalUrl);
    },
    async listUnsynced() {
      const all = (await db.getAll(STORE)) as PendingCapture[];
      return all.filter((r) => !r.synced);
    },
    async markSynced(ids) {
      const tx = db.transaction(STORE, "readwrite");
      for (const id of ids) {
        const r = (await tx.store.get(id)) as PendingCapture | undefined;
        if (r) await tx.store.put({ ...r, synced: true });
      }
      await tx.done;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pending-store.test.ts`
Expected: PASS (4 cases).

- [ ] **Step 5: Commit**

```bash
git add src/pending-store.ts tests/pending-store.test.ts
git commit -m "feat: IndexedDB pending-capture store"
```

---

## Task 5: Capture orchestration (TDD with fake store)

**Files:**
- Create: `src/capture.ts`
- Test: `tests/capture.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/capture.test.ts
import { describe, it, expect } from "vitest";
import { handleCapture } from "../src/capture";
import type { PendingCapture, PendingStore } from "../src/types";
import type { SharePayload } from "../src/types";

function fakeStore(seed: PendingCapture[] = []) {
  const data = new Map<string, PendingCapture>();
  for (const r of seed) data.set(r.id, r);
  const store = {
    putCalls: [] as PendingCapture[],
    async put(r: PendingCapture) { data.set(r.id, r); store.putCalls.push(r); },
    async getByCanonicalUrl(u: string) {
      if (!u) return undefined;
      return [...data.values()].find((r) => r.canonical_url === u);
    },
    async listUnsynced() { return [...data.values()].filter((r) => !r.synced); },
    async markSynced() {},
  };
  return store;
}

const deps = { now: () => 1234, uuid: () => "uuid-fixed" };

describe("handleCapture", () => {
  it("saves a new reel and returns saved", async () => {
    const store = fakeStore();
    const res = await handleCapture(
      { url: "https://www.instagram.com/reel/ABC123/?igsh=x" } as SharePayload,
      store,
      deps,
    );
    expect(res.status).toBe("saved");
    expect(store.putCalls).toHaveLength(1);
    expect(store.putCalls[0].canonical_url).toBe("https://www.instagram.com/reel/ABC123");
    expect(store.putCalls[0].parse_ok).toBe(true);
  });

  it("detects a duplicate and does not write a second record", async () => {
    const existing: PendingCapture = {
      id: "old", canonical_url: "https://www.instagram.com/reel/ABC123",
      raw_payload: "{}", captured_at: 1, source: "share_target",
      status: "pending", parse_ok: true, synced: false,
    };
    const store = fakeStore([existing]);
    const res = await handleCapture(
      { url: "https://www.instagram.com/reel/ABC123/" } as SharePayload, store, deps);
    expect(res.status).toBe("dup");
    expect(store.putCalls).toHaveLength(0);
  });

  it("persists an unparsed payload with parse_ok=false rather than dropping it", async () => {
    const store = fakeStore();
    const res = await handleCapture({ text: "no link here" } as SharePayload, store, deps);
    expect(res.status).toBe("unparsed");
    expect(store.putCalls).toHaveLength(1);
    expect(store.putCalls[0].parse_ok).toBe(false);
    expect(store.putCalls[0].raw_payload).toBe(JSON.stringify({ text: "no link here" }));
  });

  it("returns error when the store write throws", async () => {
    const store = fakeStore();
    store.put = async () => { throw new Error("idb fail"); };
    const res = await handleCapture(
      { url: "https://www.instagram.com/reel/ABC123/" } as SharePayload, store, deps);
    expect(res.status).toBe("error");
  });
});
```

- [ ] **Step 2: Add `PendingStore` to the import surface of `src/types.ts`**

Modify `src/types.ts` — append a re-export so tests can import the interface type from `./types`:

```typescript
export type { PendingStore } from "./pending-store";
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/capture.test.ts`
Expected: FAIL — cannot resolve `../src/capture`.

- [ ] **Step 4: Implement `src/capture.ts`**

```typescript
import { parse } from "./url-normalize";
import type { CaptureResult, PendingCapture, SharePayload } from "./types";
import type { PendingStore } from "./pending-store";

export interface CaptureDeps {
  now: () => number;
  uuid: () => string;
}

const defaultDeps: CaptureDeps = {
  now: () => Date.now(),
  uuid: () => crypto.randomUUID(),
};

export async function handleCapture(
  payload: SharePayload,
  store: PendingStore,
  deps: CaptureDeps = defaultDeps,
): Promise<CaptureResult> {
  const { canonicalUrl, parseOk } = parse(payload);

  if (parseOk) {
    const existing = await store.getByCanonicalUrl(canonicalUrl);
    if (existing) return { status: "dup", record: existing };
  }

  const record: PendingCapture = {
    id: deps.uuid(),
    canonical_url: canonicalUrl,
    raw_payload: JSON.stringify(payload),
    captured_at: deps.now(),
    source: "share_target",
    status: "pending",
    parse_ok: parseOk,
    synced: false,
  };

  try {
    await store.put(record);
  } catch {
    return { status: "error" };
  }

  return { status: parseOk ? "saved" : "unparsed", record };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/capture.test.ts`
Expected: PASS (4 cases).

- [ ] **Step 6: Commit**

```bash
git add src/capture.ts src/types.ts tests/capture.test.ts
git commit -m "feat: capture orchestration with dedupe + unparsed handling"
```

---

## Task 6: Sync drain (TDD with injected fetch)

**Files:**
- Create: `src/sync.ts`
- Test: `tests/sync.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/sync.test.ts
import { describe, it, expect, vi } from "vitest";
import { drainSync } from "../src/sync";
import type { PendingCapture, PendingStore } from "../src/types";

function rec(id: string): PendingCapture {
  return {
    id, canonical_url: `https://www.instagram.com/reel/${id}`,
    raw_payload: "{}", captured_at: 1, source: "share_target",
    status: "pending", parse_ok: true, synced: false,
  };
}

function storeWith(unsynced: PendingCapture[]): PendingStore & { marked: string[] } {
  const marked: string[] = [];
  return {
    marked,
    async put() {},
    async getByCanonicalUrl() { return undefined; },
    async listUnsynced() { return unsynced; },
    async markSynced(ids) { marked.push(...ids); },
  };
}

describe("drainSync", () => {
  it("posts unsynced records and marks accepted ids synced", async () => {
    const store = storeWith([rec("a"), rec("b")]);
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ accepted: ["a", "b"] }), { status: 200 }));
    await drainSync(store, fetchFn);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("/api/sync");
    expect(JSON.parse((init as RequestInit).body as string)).toHaveLength(2);
    expect(store.marked.sort()).toEqual(["a", "b"]);
  });

  it("does nothing when there is nothing unsynced", async () => {
    const store = storeWith([]);
    const fetchFn = vi.fn();
    await drainSync(store, fetchFn);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not mark anything synced when the request fails", async () => {
    const store = storeWith([rec("a")]);
    const fetchFn = vi.fn(async () => { throw new Error("offline"); });
    await drainSync(store, fetchFn);
    expect(store.marked).toEqual([]);
  });

  it("does not mark synced on a non-ok response", async () => {
    const store = storeWith([rec("a")]);
    const fetchFn = vi.fn(async () => new Response("err", { status: 500 }));
    await drainSync(store, fetchFn);
    expect(store.marked).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sync.test.ts`
Expected: FAIL — cannot resolve `../src/sync`.

- [ ] **Step 3: Implement `src/sync.ts`**

```typescript
import type { PendingCapture } from "./types";
import type { PendingStore } from "./pending-store";

// Fields sent to the backend (drop the local-only `synced` flag).
function toWire(r: PendingCapture) {
  const { synced, ...wire } = r;
  void synced;
  return wire;
}

export async function drainSync(
  store: PendingStore,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const unsynced = await store.listUnsynced();
  if (unsynced.length === 0) return;

  let res: Response;
  try {
    res = await fetchFn("/api/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(unsynced.map(toWire)),
    });
  } catch {
    return; // offline / unreachable — retry on next trigger
  }
  if (!res.ok) return;

  let accepted: string[];
  try {
    accepted = ((await res.json()) as { accepted: string[] }).accepted ?? [];
  } catch {
    return;
  }
  if (accepted.length) await store.markSynced(accepted);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sync.test.ts`
Expected: PASS (4 cases).

- [ ] **Step 5: Commit**

```bash
git add src/sync.ts tests/sync.test.ts
git commit -m "feat: backend sync drain with offline-safe retry"
```

---

## Task 7: Service worker (share-target handler + sync triggers)

**Files:**
- Create: `src/sw.ts`

> Not unit-tested (SW global scope + redirect behavior is exercised via manual on-device verification). Keep it thin — all logic lives in the tested modules it calls.

- [ ] **Step 1: Implement `src/sw.ts`**

```typescript
/// <reference lib="webworker" />
import { createPendingStore } from "./pending-store";
import { handleCapture } from "./capture";
import { drainSync } from "./sync";
import type { SharePayload } from "./types";

declare const self: ServiceWorkerGlobalScope;

const SHELL = ["/", "/index.html", "/captured.html", "/manifest.webmanifest"];
const CACHE = "insave-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      const store = await createPendingStore();
      await drainSync(store); // opportunistic drain on activation
    })(),
  );
});

self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);

  // Share target: intercept the POST, do synchronous capture, redirect to toast page.
  if (event.request.method === "POST" && url.pathname === "/share") {
    event.respondWith(handleShare(event.request));
    return;
  }

  // Cache-first for the app shell so /captured loads offline.
  if (event.request.method === "GET" && SHELL.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((hit) => hit ?? fetch(event.request)),
    );
  }
});

async function handleShare(request: Request): Promise<Response> {
  let payload: SharePayload = {};
  try {
    const form = await request.formData();
    payload = {
      url: (form.get("url") as string) || undefined,
      text: (form.get("text") as string) || undefined,
      title: (form.get("title") as string) || undefined,
    };
  } catch {
    /* fall through with empty payload -> unparsed */
  }

  let status: string;
  try {
    const store = await createPendingStore();
    const result = await handleCapture(payload, store);
    status = result.status;
    // fire-and-forget sync; never blocks the redirect
    drainSync(store).catch(() => {});
  } catch {
    status = "error";
  }

  return Response.redirect(`/captured.html?status=${status}`, 303);
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/sw.ts
git commit -m "feat: service worker share-target handler + sync triggers"
```

---

## Task 8: Captured toast page

**Files:**
- Create: `src/captured.ts`, `public/captured.html`

- [ ] **Step 1: Create `public/captured.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>InSave</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #111; }
      .toast {
        position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%);
        background: #222; color: #fff; padding: 14px 20px; border-radius: 10px;
        font-size: 16px; box-shadow: 0 4px 16px rgba(0,0,0,.4); opacity: 0;
        transition: opacity .2s; max-width: 90vw; text-align: center;
      }
      .toast.show { opacity: 1; }
    </style>
  </head>
  <body>
    <div id="toast" class="toast" role="status" aria-live="polite"></div>
    <script type="module" src="/src/captured.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `src/captured.ts`**

```typescript
const MESSAGES: Record<string, string> = {
  saved: "Saved. Tag it later.",
  dup: "Already in InSave.",
  unparsed: "Saved — needs a look later.",
  error: "Couldn't save, try again.",
};

const status = new URLSearchParams(location.search).get("status") ?? "saved";
const toast = document.getElementById("toast")!;
toast.textContent = MESSAGES[status] ?? MESSAGES.saved;

requestAnimationFrame(() => toast.classList.add("show"));

// Auto-dismiss and attempt to release the user back to where they came from.
const DISMISS_MS = status === "error" ? 2600 : 1500;
window.setTimeout(() => {
  toast.classList.remove("show");
  window.setTimeout(() => {
    // Best-effort return; if launched standalone there's nowhere to go back to.
    if (history.length > 1) history.back();
  }, 250);
}, DISMISS_MS);

// Allow manual dismissal.
toast.addEventListener("click", () => {
  if (history.length > 1) history.back();
});
```

- [ ] **Step 3: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add public/captured.html src/captured.ts
git commit -m "feat: capture confirmation toast page"
```

---

## Task 9: App shell, manifest, SW registration

**Files:**
- Create: `public/index.html`, `public/manifest.webmanifest`, `public/icons/icon-192.png`, `public/icons/icon-512.png`

- [ ] **Step 1: Create `public/manifest.webmanifest`**

```json
{
  "name": "InSave",
  "short_name": "InSave",
  "description": "Save Instagram reels in one tap, tag them later.",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#111111",
  "theme_color": "#111111",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ],
  "share_target": {
    "action": "/share",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": { "title": "title", "text": "text", "url": "url" }
  }
}
```

- [ ] **Step 2: Create `public/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#111111" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <title>InSave</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #111; color: #eee;
             display: grid; place-items: center; min-height: 100vh; text-align: center; }
      main { padding: 24px; max-width: 28rem; }
      h1 { font-size: 1.6rem; margin: 0 0 .5rem; }
      p { color: #aaa; line-height: 1.5; }
    </style>
  </head>
  <body>
    <main>
      <h1>InSave</h1>
      <p>Share a reel from Instagram and pick <strong>InSave</strong> to save it. Tag it later.</p>
    </main>
    <script type="module" src="/src/register-sw.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Create `src/register-sw.ts`**

```typescript
import { createPendingStore } from "./pending-store";
import { drainSync } from "./sync";

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { type: "module" }).catch(() => {});
}

// Drain whenever connectivity returns.
window.addEventListener("online", () => {
  createPendingStore().then((store) => drainSync(store)).catch(() => {});
});
```

> Note: the SW must be emitted to `/sw.js`. Add a build input for it in Task 11.

- [ ] **Step 4: Create placeholder icons**

Run (PowerShell): generate two solid PNG placeholders so the manifest resolves. Use any 192×192 and 512×512 PNG. If none available, create with:

```powershell
# minimal 1x1 transparent PNG scaled is not valid for install; use a real square.
# If you have ImageMagick:
magick -size 192x192 xc:#111111 public/icons/icon-192.png
magick -size 512x512 xc:#111111 public/icons/icon-512.png
```

If ImageMagick is unavailable, drop any two square PNGs at those paths. Icons are placeholders; final art is an onboarding/design concern (out of scope).

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/manifest.webmanifest public/icons src/register-sw.ts
git commit -m "feat: app shell, web manifest with share_target, SW registration"
```

---

## Task 10: D1 schema + sync Worker

**Files:**
- Create: `schema.sql`, `worker/index.ts`, `wrangler.toml`

- [ ] **Step 1: Create `schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS pending_capture (
  id            TEXT PRIMARY KEY,
  canonical_url TEXT,
  raw_payload   TEXT NOT NULL,
  captured_at   INTEGER NOT NULL,
  source        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  parse_ok      INTEGER NOT NULL DEFAULT 1
);

-- Dedupe key. Partial unique index so multiple parse_ok=false rows
-- (canonical_url = '') don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_url
  ON pending_capture (canonical_url)
  WHERE canonical_url <> '';
```

- [ ] **Step 2: Create `wrangler.toml`**

```toml
name = "insave"
main = "worker/index.ts"
compatibility_date = "2024-09-23"

[[d1_databases]]
binding = "DB"
database_name = "insave"
database_id = "REPLACE_WITH_D1_ID_AFTER_CREATE"
```

> The engineer creates the D1 instance with `wrangler d1 create insave` and pastes the returned `database_id`. For local dev/tests `--local` is used and the id is not required.

- [ ] **Step 3: Create `worker/index.ts`**

```typescript
interface WireRecord {
  id: string;
  canonical_url: string;
  raw_payload: string;
  captured_at: number;
  source: string;
  status: string;
  parse_ok: boolean;
}

interface Env {
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/sync") {
      return handleSync(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
};

async function handleSync(request: Request, env: Env): Promise<Response> {
  let records: WireRecord[];
  try {
    records = (await request.json()) as WireRecord[];
    if (!Array.isArray(records)) throw new Error("expected array");
  } catch {
    return new Response(JSON.stringify({ error: "bad payload" }), { status: 400 });
  }

  const accepted: string[] = [];
  const stmt = env.DB.prepare(
    `INSERT INTO pending_capture
       (id, canonical_url, raw_payload, captured_at, source, status, parse_ok)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );

  for (const r of records) {
    try {
      await stmt
        .bind(r.id, r.canonical_url, r.raw_payload, r.captured_at, r.source, r.status, r.parse_ok ? 1 : 0)
        .run();
      accepted.push(r.id); // idempotent: a no-op conflict still counts as accepted
    } catch {
      // canonical_url unique conflict (same reel, different client id) — treat as accepted
      accepted.push(r.id);
    }
  }

  return new Response(JSON.stringify({ accepted }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
```

- [ ] **Step 4: Initialize local D1 and type-check**

Run: `npx wrangler d1 execute insave --local --file=schema.sql`
Expected: schema applied locally.

Run: `npx tsc --noEmit`
Expected: no errors (install `@cloudflare/workers-types` if `D1Database` is undefined — see Step 5).

- [ ] **Step 5: Add Workers types if needed**

If `tsc` complains `D1Database`/`Env` types missing:

Run: `npm i -D @cloudflare/workers-types`

Add to `tsconfig.json` `compilerOptions.types`: `["vite/client", "@cloudflare/workers-types"]`.

- [ ] **Step 6: Commit**

```bash
git add schema.sql wrangler.toml worker/index.ts tsconfig.json package.json package-lock.json
git commit -m "feat: D1 schema and idempotent sync Worker"
```

---

## Task 11: Build wiring for the service worker output

**Files:**
- Modify: `vite.config.ts`

The SW must be emitted at the site root as `/sw.js` (module). Add it as a dedicated build that outputs a flat filename.

- [ ] **Step 1: Update `vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "public/index.html"),
        captured: resolve(__dirname, "public/captured.html"),
        sw: resolve(__dirname, "src/sw.ts"),
      },
      output: {
        // emit the service worker as /sw.js (no hash) so registration path is stable
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
      },
    },
  },
});
```

- [ ] **Step 2: Build and verify the SW emits at dist root**

Run: `npm run build`
Expected: build succeeds; `dist/sw.js` exists; `dist/index.html` and `dist/captured.html` exist.

- [ ] **Step 3: Commit**

```bash
git add vite.config.ts
git commit -m "build: emit service worker as /sw.js"
```

---

## Task 12: Full test + build gate

**Files:** none (verification task)

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: all suites pass (url-normalize, pending-store, capture, sync).

- [ ] **Step 2: Type-check + production build**

Run: `npm run build`
Expected: clean build, `dist/sw.js` present.

- [ ] **Step 3: Commit any fixes** (only if Steps 1–2 surfaced issues)

```bash
git add -A
git commit -m "test: green unit suite + clean build"
```

---

## Task 13: Manual verification doc

**Files:**
- Create: `docs/manual-verification.md`

- [ ] **Step 1: Write `docs/manual-verification.md`**

```markdown
# PRD01 Manual Verification (real Android device)

These acceptance items require an installed PWA + live Instagram and cannot be unit-tested.

## Setup
1. Deploy to Cloudflare Pages over HTTPS (or use `wrangler pages dev` with a tunnel).
2. On an Android device, open the site in Chrome and "Add to Home screen" (install).
3. Create the D1 database: `wrangler d1 create insave`, paste id into `wrangler.toml`,
   apply `schema.sql` remotely: `wrangler d1 execute insave --file=schema.sql`.
4. Deploy the Worker: `wrangler deploy`.

## Checklist (PRD §9)
- [ ] Installed PWA "InSave" appears in Instagram's Android share sheet.
- [ ] Sharing a reel shows the "Saved. Tag it later." toast and returns to Instagram.
- [ ] Sharing the SAME reel again shows "Already in InSave." and creates no duplicate
      (verify one row in D1: `SELECT count(*) FROM pending_capture WHERE canonical_url=...`).
- [ ] Confirm which payload field carries the URL (log `raw_payload`); handler recovers it.
- [ ] Capture feels sub-1s on a mid-range device.
- [ ] Turn on airplane mode, share a reel → still saves + toast; turn network back on →
      record appears in D1 within a few seconds (online drain) or on next app launch.
- [ ] Share something with no Instagram URL → "Saved — needs a look later.",
      row stored with `parse_ok = 0`, nothing dropped.
```

- [ ] **Step 2: Commit**

```bash
git add docs/manual-verification.md
git commit -m "docs: manual on-device verification checklist"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** every PRD §9 acceptance item maps to a task (automated) or the manual doc (device-dependent). Share target → T9; normalize/dedupe/unparsed → T3/T5; offline+sync → T6/T7/T9; D1 contract → T10.
- **Type consistency:** `PendingCapture`, `PendingStore`, `CaptureResult`, `SharePayload`, `handleCapture(payload, store, deps)`, `drainSync(store, fetchFn)`, `createPendingStore()` are used identically across tasks.
- **Idempotency:** local dedupe (T5) + backend `ON CONFLICT(id) DO NOTHING` + canonical_url unique index (T10) + `accepted` always returned so `markSynced` clears the local queue.
- **No placeholders:** every code step contains full code; the only `REPLACE_WITH_D1_ID` is an inherently external value, documented with the command that produces it.
```