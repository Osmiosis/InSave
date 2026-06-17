# PRD02 Backlog Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user upload their Instagram data export, triage the backlog of saved reels (grouped by author, with bulk actions, zero Instagram requests), and promote the keepers into PRD01's `pending_capture` flow.

**Architecture:** Client-only pipeline (zip → parse → normalize → reconcile → IndexedDB `imported_item` store, all dormant) feeding a triage UI; promotion reuses PRD01's `pending_capture` + `drainSync` + D1 path. Enrichment is a swappable interface with a no-op stub.

**Tech Stack:** Vite + TypeScript, Vitest, fake-indexeddb, `idb`, `fflate` (zip), Cloudflare Workers + D1. Reuses PRD01 `url-normalize.parse`, `pending-store`, `sync`.

---

## File Structure

```
import.html                       # NEW triage page (Vite input)
src/db.ts                         # NEW shared openInsaveDB (version 2)
src/import/
  errors.ts                       # ImportError
  zip.ts                          # extractSavedPostsJson(Blob) -> json text (fflate)
  parse-saved-posts.ts            # parseSavedPosts(text) -> ParsedSavedItem[]
  normalize-import.ts             # toImportedItems(parsed) -> ImportedItem[]
  imported-store.ts               # IndexedDB CRUD over imported_item
  reconcile.ts                    # dedupe vs existing stores
  enrichment.ts                   # Enricher interface + stubEnricher
  promote.ts                      # promote(item, deps)
  triage.ts                       # groupAndSort(items) -> AuthorGroup[]
  triage-view.ts                  # DOM wiring for import.html
tests/import/*.test.ts            # unit tests per module
src/types.ts                      # MODIFY: new types + PendingCapture extension
src/pending-store.ts             # MODIFY: use openInsaveDB (interface unchanged)
index.html                        # MODIFY: link to /import.html
vite.config.ts                    # MODIFY: add import.html input
schema.sql                        # MODIFY: nullable saved_at/title/thumbnail/description
worker/index.ts                   # MODIFY: bind new columns ?? null
package.json                      # MODIFY: + fflate
docs/manual-verification.md       # MODIFY: import section
```

---

## Task 1: Dependencies + type extensions

**Files:**
- Modify: `package.json` (add `fflate`)
- Modify: `src/types.ts`

- [ ] **Step 1: Install fflate**

Run: `npm i fflate@^0.8.2`
Expected: added to `dependencies`, no errors.

- [ ] **Step 2: Append new types to `src/types.ts`**

Add to the END of `src/types.ts` (do NOT remove the existing `export type { PendingStore } from "./pending-store";` line — keep it last):

```typescript
export type BacklogState = "dormant" | "promoted";

export interface ParsedSavedItem {
  url: string;
  author: string;
  savedAt: number; // epoch ms (converted from the export's seconds)
}

export interface ImportedItem {
  id: string;
  canonical_url: string;
  author: string;
  saved_at: number;    // original Instagram save timestamp, epoch ms
  imported_at: number; // when InSave ingested it, epoch ms
  raw_payload: string; // JSON of the raw export entry
  parse_ok: boolean;
  backlog_state: BacklogState;
}

export interface EnrichmentResult {
  title?: string;
  thumbnail?: string;
  description?: string;
}
```

- [ ] **Step 3: Extend `PendingCapture` in `src/types.ts`**

Find the `PendingCapture` interface and add these optional fields before its closing brace (after `synced: boolean;`):

```typescript
  // Import metadata / enrichment seam (undefined for share-captures).
  saved_at?: number;
  title?: string;
  thumbnail?: string;
  description?: string;
```

- [ ] **Step 4: Verify type-check and existing tests still pass**

Run: `npx tsc --noEmit`
Expected: exit 0.
Run: `npx vitest run`
Expected: 20/20 pass (unchanged).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/types.ts
git -c user.name="InSave" -c user.email="kgspune@gmail.com" commit -m "feat: add fflate and import/enrichment types

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Shared DB module + pending-store refactor

**Files:**
- Create: `src/db.ts`
- Modify: `src/pending-store.ts`

- [ ] **Step 1: Create `src/db.ts`**

```typescript
import { openDB, type IDBPDatabase } from "idb";

export const DB_NAME = "insave";
export const PENDING_STORE = "pending_capture";
export const IMPORTED_STORE = "imported_item";

// Single owner of the IndexedDB schema. Version 2 adds the imported_item store.
export async function openInsaveDB(): Promise<IDBPDatabase> {
  const db = await openDB(DB_NAME, 2, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        const os = database.createObjectStore(PENDING_STORE, { keyPath: "id" });
        os.createIndex("by_canonical_url", "canonical_url", { unique: false });
      }
      if (oldVersion < 2) {
        const os = database.createObjectStore(IMPORTED_STORE, { keyPath: "id" });
        os.createIndex("by_canonical_url", "canonical_url", { unique: false });
      }
    },
  });
  // Auto-close when another context requests a version change (e.g. deleteDatabase in tests).
  db.addEventListener("versionchange", () => db.close());
  return db;
}
```

- [ ] **Step 2: Replace the body of `src/pending-store.ts`**

Keep the SAME public interface (`PendingStore`, `createPendingStore`). Replace the file contents with:

```typescript
import { openInsaveDB, PENDING_STORE } from "./db";
import type { PendingCapture } from "./types";

export interface PendingStore {
  put(record: PendingCapture): Promise<void>;
  getByCanonicalUrl(canonicalUrl: string): Promise<PendingCapture | undefined>;
  listUnsynced(): Promise<PendingCapture[]>;
  markSynced(ids: string[]): Promise<void>;
}

export async function createPendingStore(): Promise<PendingStore> {
  const db = await openInsaveDB();

  return {
    async put(record) {
      await db.put(PENDING_STORE, record);
    },
    async getByCanonicalUrl(canonicalUrl) {
      if (!canonicalUrl) return undefined;
      return db.getFromIndex(PENDING_STORE, "by_canonical_url", canonicalUrl);
    },
    async listUnsynced() {
      const all = (await db.getAll(PENDING_STORE)) as PendingCapture[];
      return all.filter((r) => !r.synced);
    },
    async markSynced(ids) {
      const tx = db.transaction(PENDING_STORE, "readwrite");
      for (const id of ids) {
        const r = (await tx.store.get(id)) as PendingCapture | undefined;
        if (r) await tx.store.put({ ...r, synced: true });
      }
      await tx.done;
    },
  };
}
```

- [ ] **Step 3: Verify nothing broke**

Run: `npx tsc --noEmit`
Expected: exit 0.
Run: `npx vitest run`
Expected: 20/20 pass (pending-store, capture, sync, url-normalize all still green — the DB now opens at v2 but the pending_capture store and its index are unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/db.ts src/pending-store.ts
git -c user.name="InSave" -c user.email="kgspune@gmail.com" commit -m "refactor: extract shared openInsaveDB (v2) for the imported_item store

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Imported store (IndexedDB, TDD)

**Files:**
- Create: `src/import/imported-store.ts`
- Test: `tests/import/imported-store.test.ts`

- [ ] **Step 1: Write `tests/import/imported-store.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { indexedDB } from "fake-indexeddb";
import { createImportedStore } from "../../src/import/imported-store";
import { createPendingStore } from "../../src/pending-store";
import type { ImportedItem } from "../../src/types";

function item(over: Partial<ImportedItem> = {}): ImportedItem {
  return {
    id: over.id ?? "i-1",
    canonical_url: over.canonical_url ?? "https://www.instagram.com/reel/A",
    author: over.author ?? "alice",
    saved_at: over.saved_at ?? 1000,
    imported_at: 2000,
    raw_payload: "{}",
    parse_ok: true,
    backlog_state: over.backlog_state ?? "dormant",
    ...over,
  };
}

describe("imported-store", () => {
  beforeEach(async () => {
    await new Promise<void>((res) => {
      const del = indexedDB.deleteDatabase("insave");
      del.onsuccess = () => res();
      del.onerror = () => res();
      del.onblocked = () => res();
    });
  });

  it("bulkPut then listAll returns all items", async () => {
    const store = await createImportedStore();
    await store.bulkPut([item({ id: "a", canonical_url: "u-a" }), item({ id: "b", canonical_url: "u-b" })]);
    const all = await store.listAll();
    expect(all.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("getByCanonicalUrl finds a stored item", async () => {
    const store = await createImportedStore();
    await store.bulkPut([item({ id: "a", canonical_url: "u-a" })]);
    expect((await store.getByCanonicalUrl("u-a"))?.id).toBe("a");
    expect(await store.getByCanonicalUrl("nope")).toBeUndefined();
  });

  it("listByState filters by backlog_state", async () => {
    const store = await createImportedStore();
    await store.bulkPut([
      item({ id: "a", canonical_url: "u-a", backlog_state: "dormant" }),
      item({ id: "b", canonical_url: "u-b", backlog_state: "promoted" }),
    ]);
    expect((await store.listByState("dormant")).map((r) => r.id)).toEqual(["a"]);
    expect((await store.listByState("promoted")).map((r) => r.id)).toEqual(["b"]);
  });

  it("setState transitions an item", async () => {
    const store = await createImportedStore();
    await store.bulkPut([item({ id: "a", canonical_url: "u-a", backlog_state: "dormant" })]);
    await store.setState("a", "promoted");
    expect((await store.getByCanonicalUrl("u-a"))?.backlog_state).toBe("promoted");
  });

  it("coexists with the pending_capture store on the same v2 database", async () => {
    const imported = await createImportedStore();
    const pending = await createPendingStore();
    await imported.bulkPut([item({ id: "a", canonical_url: "u-a" })]);
    await pending.put({
      id: "p", canonical_url: "u-p", raw_payload: "{}", captured_at: 1,
      source: "share_target", status: "pending", parse_ok: true, synced: false,
    });
    expect((await imported.listAll()).length).toBe(1);
    expect(await pending.getByCanonicalUrl("u-p")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/import/imported-store.test.ts`
Expected: FAIL — cannot resolve `../../src/import/imported-store`.

- [ ] **Step 3: Implement `src/import/imported-store.ts`**

```typescript
import { openInsaveDB, IMPORTED_STORE } from "../db";
import type { BacklogState, ImportedItem } from "../types";

export interface ImportedStore {
  bulkPut(items: ImportedItem[]): Promise<void>;
  getByCanonicalUrl(canonicalUrl: string): Promise<ImportedItem | undefined>;
  listAll(): Promise<ImportedItem[]>;
  listByState(state: BacklogState): Promise<ImportedItem[]>;
  setState(id: string, state: BacklogState): Promise<void>;
}

export async function createImportedStore(): Promise<ImportedStore> {
  const db = await openInsaveDB();

  return {
    async bulkPut(items) {
      const tx = db.transaction(IMPORTED_STORE, "readwrite");
      for (const it of items) await tx.store.put(it);
      await tx.done;
    },
    async getByCanonicalUrl(canonicalUrl) {
      if (!canonicalUrl) return undefined;
      return db.getFromIndex(IMPORTED_STORE, "by_canonical_url", canonicalUrl);
    },
    async listAll() {
      return (await db.getAll(IMPORTED_STORE)) as ImportedItem[];
    },
    async listByState(state) {
      const all = (await db.getAll(IMPORTED_STORE)) as ImportedItem[];
      return all.filter((r) => r.backlog_state === state);
    },
    async setState(id, state) {
      const tx = db.transaction(IMPORTED_STORE, "readwrite");
      const r = (await tx.store.get(id)) as ImportedItem | undefined;
      if (r) await tx.store.put({ ...r, backlog_state: state });
      await tx.done;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/import/imported-store.test.ts`
Expected: PASS (5 cases).

- [ ] **Step 5: Commit**

```bash
git add src/import/imported-store.ts tests/import/imported-store.test.ts
git -c user.name="InSave" -c user.email="kgspune@gmail.com" commit -m "feat: imported_item IndexedDB store

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Saved-posts parser (TDD)

**Files:**
- Create: `src/import/errors.ts`
- Create: `src/import/parse-saved-posts.ts`
- Test: `tests/import/parse-saved-posts.test.ts`

- [ ] **Step 1: Create `src/import/errors.ts`**

```typescript
// Raised when an uploaded file cannot be read as an Instagram saved-posts export.
// Carries a user-facing message safe to show directly.
export class ImportError extends Error {
  constructor(message = "We couldn't read your saved posts from this file.") {
    super(message);
    this.name = "ImportError";
  }
}
```

- [ ] **Step 2: Write `tests/import/parse-saved-posts.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { parseSavedPosts } from "../../src/import/parse-saved-posts";
import { ImportError } from "../../src/import/errors";

const real = JSON.stringify({
  saved_saved_media: [
    {
      title: "creator_one",
      string_map_data: {
        "Saved on": { href: "https://www.instagram.com/reel/AAA/", timestamp: 1700000000 },
      },
    },
    {
      title: "creator_two",
      string_map_data: {
        "Saved on": { href: "https://www.instagram.com/reel/BBB/", timestamp: 1700000100 },
      },
    },
  ],
});

describe("parseSavedPosts", () => {
  it("extracts url, author and timestamp (seconds -> ms)", () => {
    const items = parseSavedPosts(real);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      url: "https://www.instagram.com/reel/AAA/",
      author: "creator_one",
      savedAt: 1700000000000,
    });
  });

  it("falls back to the first string_map_data slot when 'Saved on' is absent", () => {
    const variant = JSON.stringify({
      saved_saved_media: [
        { title: "c", string_map_data: { "Added": { href: "https://www.instagram.com/reel/CCC/", timestamp: 5 } } },
      ],
    });
    const items = parseSavedPosts(variant);
    expect(items[0].url).toBe("https://www.instagram.com/reel/CCC/");
    expect(items[0].savedAt).toBe(5000);
  });

  it("throws ImportError on invalid JSON", () => {
    expect(() => parseSavedPosts("{not json")).toThrow(ImportError);
  });

  it("throws ImportError when saved_saved_media is missing", () => {
    expect(() => parseSavedPosts(JSON.stringify({ something_else: [] }))).toThrow(ImportError);
  });

  it("throws ImportError when there are zero parseable entries", () => {
    expect(() => parseSavedPosts(JSON.stringify({ saved_saved_media: [] }))).toThrow(ImportError);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/import/parse-saved-posts.test.ts`
Expected: FAIL — cannot resolve `../../src/import/parse-saved-posts`.

- [ ] **Step 4: Implement `src/import/parse-saved-posts.ts`**

```typescript
import type { ParsedSavedItem } from "../types";
import { ImportError } from "./errors";

interface MapSlot {
  href?: unknown;
  timestamp?: unknown;
}

export function parseSavedPosts(jsonText: string): ParsedSavedItem[] {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new ImportError();
  }

  const list = (data as { saved_saved_media?: unknown })?.saved_saved_media;
  if (!Array.isArray(list)) throw new ImportError();

  const items: ParsedSavedItem[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { title?: unknown; string_map_data?: unknown };
    const author = typeof e.title === "string" ? e.title : "";

    let href = "";
    let tsSeconds = 0;
    const map = e.string_map_data;
    if (map && typeof map === "object") {
      const slots = map as Record<string, MapSlot>;
      const slot = slots["Saved on"] ?? Object.values(slots)[0];
      if (slot && typeof slot === "object") {
        if (typeof slot.href === "string") href = slot.href;
        if (typeof slot.timestamp === "number") tsSeconds = slot.timestamp;
      }
    }

    items.push({ url: href, author, savedAt: tsSeconds > 0 ? tsSeconds * 1000 : 0 });
  }

  if (items.length === 0) throw new ImportError();
  return items;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/import/parse-saved-posts.test.ts`
Expected: PASS (5 cases).

- [ ] **Step 6: Commit**

```bash
git add src/import/errors.ts src/import/parse-saved-posts.ts tests/import/parse-saved-posts.test.ts
git -c user.name="InSave" -c user.email="kgspune@gmail.com" commit -m "feat: defensive Instagram saved-posts parser

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Zip extraction (TDD, fflate)

**Files:**
- Create: `src/import/zip.ts`
- Test: `tests/import/zip.test.ts`

- [ ] **Step 1: Write `tests/import/zip.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { extractSavedPostsJson } from "../../src/import/zip";
import { ImportError } from "../../src/import/errors";

const JSON_TEXT = JSON.stringify({ saved_saved_media: [{ title: "x" }] });

describe("extractSavedPostsJson", () => {
  it("returns the text unchanged when given a plain JSON blob", async () => {
    const blob = new Blob([strToU8(JSON_TEXT)]);
    const text = await extractSavedPostsJson(blob);
    expect(JSON.parse(text)).toHaveProperty("saved_saved_media");
  });

  it("locates and extracts a nested saved_posts.json from a zip", async () => {
    const zipped = zipSync({
      "your_instagram_activity/saved/saved_posts.json": strToU8(JSON_TEXT),
    });
    const blob = new Blob([zipped]);
    const text = await extractSavedPostsJson(blob);
    expect(JSON.parse(text)).toHaveProperty("saved_saved_media");
  });

  it("throws ImportError for a zip with no saved_posts.json", async () => {
    const zipped = zipSync({ "other/file.txt": strToU8("hello") });
    const blob = new Blob([zipped]);
    await expect(extractSavedPostsJson(blob)).rejects.toThrow(ImportError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/import/zip.test.ts`
Expected: FAIL — cannot resolve `../../src/import/zip`.

- [ ] **Step 3: Implement `src/import/zip.ts`**

```typescript
import { unzipSync, strFromU8 } from "fflate";
import { ImportError } from "./errors";

// PK\x03\x04 (local file header) or PK\x05\x06 (empty archive end record).
function isZip(buf: Uint8Array): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    (buf[2] === 0x03 || buf[2] === 0x05) &&
    (buf[3] === 0x04 || buf[3] === 0x06)
  );
}

export async function extractSavedPostsJson(file: Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());

  if (isZip(buf)) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(buf);
    } catch {
      throw new ImportError("We couldn't open this zip file.");
    }
    const key = Object.keys(entries).find((k) => k.toLowerCase().endsWith("saved_posts.json"));
    if (!key) throw new ImportError("We couldn't find your saved posts in this zip.");
    return strFromU8(entries[key]);
  }

  // Not a zip: assume it's the JSON file itself.
  return strFromU8(buf);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/import/zip.test.ts`
Expected: PASS (3 cases). (Node 18.13+/20 provides global `Blob`; vitest "node" env supports it.)

- [ ] **Step 5: Commit**

```bash
git add src/import/zip.ts tests/import/zip.test.ts
git -c user.name="InSave" -c user.email="kgspune@gmail.com" commit -m "feat: client-side zip extraction of saved_posts.json

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Normalize parsed items (TDD)

**Files:**
- Create: `src/import/normalize-import.ts`
- Test: `tests/import/normalize-import.test.ts`

- [ ] **Step 1: Write `tests/import/normalize-import.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { toImportedItems } from "../../src/import/normalize-import";
import type { ParsedSavedItem } from "../../src/types";

let n = 0;
const deps = { now: () => 5000, uuid: () => `id-${n++}` };

function parsed(url: string, author = "a", savedAt = 1): ParsedSavedItem {
  return { url, author, savedAt };
}

describe("toImportedItems", () => {
  it("canonicalizes and marks parse_ok for a valid reel", () => {
    n = 0;
    const out = toImportedItems([parsed("https://www.instagram.com/reel/AAA/?igsh=x")], deps);
    expect(out).toHaveLength(1);
    expect(out[0].canonical_url).toBe("https://www.instagram.com/reel/AAA");
    expect(out[0].parse_ok).toBe(true);
    expect(out[0].backlog_state).toBe("dormant");
    expect(out[0].imported_at).toBe(5000);
  });

  it("collapses two share-variants of the same reel within the batch", () => {
    n = 0;
    const out = toImportedItems(
      [
        parsed("https://www.instagram.com/reel/AAA/?igsh=x"),
        parsed("https://instagram.com/reel/AAA"),
      ],
      deps,
    );
    expect(out).toHaveLength(1);
  });

  it("keeps an unparseable url as parse_ok=false (never dropped)", () => {
    n = 0;
    const out = toImportedItems([parsed("not a url")], deps);
    expect(out).toHaveLength(1);
    expect(out[0].parse_ok).toBe(false);
    expect(out[0].canonical_url).toBe("");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/import/normalize-import.test.ts`
Expected: FAIL — cannot resolve `../../src/import/normalize-import`.

- [ ] **Step 3: Implement `src/import/normalize-import.ts`**

```typescript
import { parse } from "../url-normalize";
import type { ImportedItem, ParsedSavedItem } from "../types";

export interface NormalizeDeps {
  now: () => number;
  uuid: () => string;
}

const defaultDeps: NormalizeDeps = {
  now: () => Date.now(),
  uuid: () => crypto.randomUUID(),
};

export function toImportedItems(
  parsed: ParsedSavedItem[],
  deps: NormalizeDeps = defaultDeps,
): ImportedItem[] {
  const seen = new Set<string>();
  const importedAt = deps.now();
  const out: ImportedItem[] = [];

  for (const p of parsed) {
    const { canonicalUrl, parseOk } = parse({ url: p.url });
    if (parseOk && seen.has(canonicalUrl)) continue; // in-batch dedupe, first wins
    if (parseOk) seen.add(canonicalUrl);

    out.push({
      id: deps.uuid(),
      canonical_url: canonicalUrl,
      author: p.author,
      saved_at: p.savedAt,
      imported_at: importedAt,
      raw_payload: JSON.stringify(p),
      parse_ok: parseOk,
      backlog_state: "dormant",
    });
  }

  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/import/normalize-import.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/import/normalize-import.ts tests/import/normalize-import.test.ts
git -c user.name="InSave" -c user.email="kgspune@gmail.com" commit -m "feat: normalize parsed saved items to ImportedItem (reuses url-normalize)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Reconcile against existing records (TDD)

**Files:**
- Create: `src/import/reconcile.ts`
- Test: `tests/import/reconcile.test.ts`

- [ ] **Step 1: Write `tests/import/reconcile.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { reconcile } from "../../src/import/reconcile";
import type { ImportedItem } from "../../src/types";

function item(id: string, canonical_url: string, parse_ok = true): ImportedItem {
  return {
    id, canonical_url, author: "a", saved_at: 1, imported_at: 2,
    raw_payload: "{}", parse_ok, backlog_state: "dormant",
  };
}

function lookup(imported: string[], captures: string[]) {
  return {
    async existingImported(u: string) { return imported.includes(u); },
    async existingCapture(u: string) { return captures.includes(u); },
  };
}

describe("reconcile", () => {
  it("inserts genuinely new items", async () => {
    const res = await reconcile([item("a", "u-a"), item("b", "u-b")], lookup([], []));
    expect(res.toInsert.map((r) => r.id)).toEqual(["a", "b"]);
    expect(res.skippedExisting).toBe(0);
  });

  it("skips items already present as an imported item", async () => {
    const res = await reconcile([item("a", "u-a")], lookup(["u-a"], []));
    expect(res.toInsert).toEqual([]);
    expect(res.skippedExisting).toBe(1);
  });

  it("skips items already present as a capture/promoted record", async () => {
    const res = await reconcile([item("a", "u-a")], lookup([], ["u-a"]));
    expect(res.toInsert).toEqual([]);
    expect(res.skippedExisting).toBe(1);
  });

  it("always inserts unparsed items (no dedupe key)", async () => {
    const res = await reconcile([item("a", "", false)], lookup([], []));
    expect(res.toInsert.map((r) => r.id)).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/import/reconcile.test.ts`
Expected: FAIL — cannot resolve `../../src/import/reconcile`.

- [ ] **Step 3: Implement `src/import/reconcile.ts`**

```typescript
import type { ImportedItem } from "../types";

export interface ReconcileLookup {
  existingImported(canonicalUrl: string): Promise<boolean>;
  existingCapture(canonicalUrl: string): Promise<boolean>;
}

export interface ReconcileResult {
  toInsert: ImportedItem[];
  skippedExisting: number;
}

export async function reconcile(
  incoming: ImportedItem[],
  lookup: ReconcileLookup,
): Promise<ReconcileResult> {
  const toInsert: ImportedItem[] = [];
  let skippedExisting = 0;

  for (const item of incoming) {
    // Unparsed items have no usable dedupe key — keep them (flagged for review).
    if (!item.parse_ok || !item.canonical_url) {
      toInsert.push(item);
      continue;
    }
    const known =
      (await lookup.existingImported(item.canonical_url)) ||
      (await lookup.existingCapture(item.canonical_url));
    if (known) {
      skippedExisting++;
      continue;
    }
    toInsert.push(item);
  }

  return { toInsert, skippedExisting };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/import/reconcile.test.ts`
Expected: PASS (4 cases).

- [ ] **Step 5: Commit**

```bash
git add src/import/reconcile.ts tests/import/reconcile.test.ts
git -c user.name="InSave" -c user.email="kgspune@gmail.com" commit -m "feat: reconcile imported items against existing records

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Enrichment interface + stub (TDD)

**Files:**
- Create: `src/import/enrichment.ts`
- Test: `tests/import/enrichment.test.ts`

- [ ] **Step 1: Write `tests/import/enrichment.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { stubEnricher } from "../../src/import/enrichment";

describe("stubEnricher", () => {
  it("returns null (no enrichment available)", async () => {
    expect(await stubEnricher.enrich("https://www.instagram.com/reel/A")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/import/enrichment.test.ts`
Expected: FAIL — cannot resolve `../../src/import/enrichment`.

- [ ] **Step 3: Implement `src/import/enrichment.ts`**

```typescript
import type { EnrichmentResult } from "../types";

// The swappable enrichment seam. A real implementation (oEmbed/scrape) can replace
// the stub without touching the import or tag-queue flow. Only ever called on
// promoted items.
export interface Enricher {
  enrich(canonicalUrl: string): Promise<EnrichmentResult | null>;
}

export const stubEnricher: Enricher = {
  async enrich() {
    return null;
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/import/enrichment.test.ts`
Expected: PASS (1 case).

- [ ] **Step 5: Commit**

```bash
git add src/import/enrichment.ts tests/import/enrichment.test.ts
git -c user.name="InSave" -c user.email="kgspune@gmail.com" commit -m "feat: pluggable enrichment interface with no-op stub

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Promote (TDD)

**Files:**
- Create: `src/import/promote.ts`
- Test: `tests/import/promote.test.ts`

- [ ] **Step 1: Write `tests/import/promote.test.ts`**

```typescript
import { describe, it, expect, vi } from "vitest";
import { promote } from "../../src/import/promote";
import type { ImportedItem, PendingCapture } from "../../src/types";

function item(): ImportedItem {
  return {
    id: "i-1", canonical_url: "https://www.instagram.com/reel/A", author: "a",
    saved_at: 1000, imported_at: 2000, raw_payload: '{"x":1}', parse_ok: true,
    backlog_state: "dormant",
  };
}

function deps() {
  const setState = vi.fn(async () => {});
  const put = vi.fn(async (_r: PendingCapture) => {});
  const enrich = vi.fn(async () => null);
  const drain = vi.fn(() => {});
  return {
    setState, put, enrich, drain,
    obj: {
      importedStore: { setState, bulkPut: async () => {}, getByCanonicalUrl: async () => undefined, listAll: async () => [], listByState: async () => [] },
      pendingStore: { put, getByCanonicalUrl: async () => undefined, listUnsynced: async () => [], markSynced: async () => {} },
      enricher: { enrich },
      drain,
      uuid: () => "new-id",
    },
  };
}

describe("promote", () => {
  it("flips state, writes a source=import pending record, enriches, and drains", async () => {
    const d = deps();
    await promote(item(), d.obj);

    expect(d.setState).toHaveBeenCalledWith("i-1", "promoted");
    expect(d.enrich).toHaveBeenCalledWith("https://www.instagram.com/reel/A");
    expect(d.drain).toHaveBeenCalledOnce();
    expect(d.put).toHaveBeenCalledOnce();

    const rec = d.put.mock.calls[0][0];
    expect(rec.source).toBe("import");
    expect(rec.status).toBe("pending");
    expect(rec.synced).toBe(false);
    expect(rec.saved_at).toBe(1000);
    expect(rec.canonical_url).toBe("https://www.instagram.com/reel/A");
    expect(rec.captured_at).toBe(2000); // imported_at
  });

  it("merges enrichment fields when the enricher returns them", async () => {
    const d = deps();
    d.enrich.mockResolvedValueOnce({ title: "T", thumbnail: "th" } as never);
    await promote(item(), d.obj);
    const rec = d.put.mock.calls[0][0];
    expect(rec.title).toBe("T");
    expect(rec.thumbnail).toBe("th");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/import/promote.test.ts`
Expected: FAIL — cannot resolve `../../src/import/promote`.

- [ ] **Step 3: Implement `src/import/promote.ts`**

```typescript
import type { ImportedItem, PendingCapture } from "../types";
import type { ImportedStore } from "./imported-store";
import type { PendingStore } from "../pending-store";
import type { Enricher } from "./enrichment";

export interface PromoteDeps {
  importedStore: ImportedStore;
  pendingStore: PendingStore;
  enricher: Enricher;
  drain: () => void; // fire-and-forget sync trigger
  uuid: () => string;
}

export async function promote(item: ImportedItem, deps: PromoteDeps): Promise<void> {
  await deps.importedStore.setState(item.id, "promoted");

  const enrichment = await deps.enricher.enrich(item.canonical_url);

  const record: PendingCapture = {
    id: deps.uuid(),
    canonical_url: item.canonical_url,
    raw_payload: item.raw_payload,
    captured_at: item.imported_at,
    source: "import",
    status: "pending",
    parse_ok: item.parse_ok,
    synced: false,
    saved_at: item.saved_at,
    ...(enrichment ?? {}),
  };

  await deps.pendingStore.put(record);
  deps.drain();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/import/promote.test.ts`
Expected: PASS (2 cases).

- [ ] **Step 5: Commit**

```bash
git add src/import/promote.ts tests/import/promote.test.ts
git -c user.name="InSave" -c user.email="kgspune@gmail.com" commit -m "feat: promote imported item into pending_capture flow

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Triage grouping (TDD)

**Files:**
- Create: `src/import/triage.ts`
- Test: `tests/import/triage.test.ts`

- [ ] **Step 1: Write `tests/import/triage.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { groupAndSort } from "../../src/import/triage";
import type { ImportedItem } from "../../src/types";

function item(id: string, author: string, saved_at: number): ImportedItem {
  return {
    id, canonical_url: `u-${id}`, author, saved_at, imported_at: 0,
    raw_payload: "{}", parse_ok: true, backlog_state: "dormant",
  };
}

describe("groupAndSort", () => {
  it("groups by author, newest item first within a group", () => {
    const groups = groupAndSort([
      item("a1", "alice", 10),
      item("a2", "alice", 30),
      item("b1", "bob", 20),
    ]);
    const alice = groups.find((g) => g.author === "alice")!;
    expect(alice.items.map((i) => i.id)).toEqual(["a2", "a1"]);
  });

  it("orders groups by their most-recent save, newest group first", () => {
    const groups = groupAndSort([
      item("a1", "alice", 10),
      item("b1", "bob", 50),
    ]);
    expect(groups.map((g) => g.author)).toEqual(["bob", "alice"]);
  });

  it("buckets empty author under (unknown)", () => {
    const groups = groupAndSort([item("x", "", 5)]);
    expect(groups[0].author).toBe("(unknown)");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/import/triage.test.ts`
Expected: FAIL — cannot resolve `../../src/import/triage`.

- [ ] **Step 3: Implement `src/import/triage.ts`**

```typescript
import type { ImportedItem } from "../types";

export interface AuthorGroup {
  author: string;
  items: ImportedItem[];
}

export function groupAndSort(items: ImportedItem[]): AuthorGroup[] {
  const byAuthor = new Map<string, ImportedItem[]>();
  for (const it of items) {
    const key = it.author || "(unknown)";
    const bucket = byAuthor.get(key);
    if (bucket) bucket.push(it);
    else byAuthor.set(key, [it]);
  }

  const groups: AuthorGroup[] = [];
  for (const [author, groupItems] of byAuthor) {
    groupItems.sort((a, b) => b.saved_at - a.saved_at); // newest first within group
    groups.push({ author, items: groupItems });
  }

  // Most-recent group first (groupItems[0] is the group's newest after the sort above).
  groups.sort((a, b) => b.items[0].saved_at - a.items[0].saved_at);
  return groups;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/import/triage.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/import/triage.ts tests/import/triage.test.ts
git -c user.name="InSave" -c user.email="kgspune@gmail.com" commit -m "feat: triage grouping/sorting by author and recency

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: Triage UI page (DOM wiring, verified by tsc + build)

**Files:**
- Create: `import.html`
- Create: `src/import/triage-view.ts`
- Modify: `index.html` (add a link)
- Modify: `vite.config.ts` (add `import.html` input)

> Not unit-tested (DOM glue). All logic lives in the tested modules it calls. Keep it thin.

- [ ] **Step 1: Create `import.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#111111" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <title>InSave — Import backlog</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #111; color: #eee; }
      header { padding: 20px; }
      h1 { font-size: 1.3rem; margin: 0 0 8px; }
      p { color: #aaa; margin: 4px 0; line-height: 1.5; }
      .bar { padding: 0 20px 16px; }
      .banner { margin: 12px 20px; padding: 12px 16px; border-radius: 8px; background: #4a1f1f; color: #ffd6d6; display: none; }
      .banner.show { display: block; }
      .group { border-top: 1px solid #222; padding: 12px 20px; }
      .group h2 { font-size: 1rem; margin: 0 0 8px; }
      .group .bulk button { margin-right: 8px; }
      ul { list-style: none; margin: 8px 0 0; padding: 0; }
      li { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
      li a { color: #8ab4ff; text-decoration: none; word-break: break-all; flex: 1; }
      li.kept { opacity: .5; }
      button { background: #2a2a2a; color: #eee; border: 1px solid #3a3a3a; border-radius: 6px; padding: 6px 10px; font-size: 14px; }
      .summary { padding: 12px 20px; color: #9c9; }
    </style>
  </head>
  <body>
    <header>
      <h1>Import your saved reels</h1>
      <p>Upload your Instagram data export (the <code>.zip</code> Instagram emails you) or the
         <code>saved_posts.json</code> inside it. Nothing is sent to Instagram.</p>
      <p><a href="/" style="color:#8ab4ff">← Back</a></p>
    </header>
    <div class="bar">
      <input id="file" type="file" accept=".zip,.json,application/zip,application/json" />
    </div>
    <div id="banner" class="banner" role="alert"></div>
    <div id="summary" class="summary"></div>
    <div id="list"></div>
    <script type="module" src="/src/import/triage-view.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `src/import/triage-view.ts`**

```typescript
import { extractSavedPostsJson } from "./zip";
import { parseSavedPosts } from "./parse-saved-posts";
import { toImportedItems } from "./normalize-import";
import { reconcile } from "./reconcile";
import { groupAndSort, type AuthorGroup } from "./triage";
import { promote as promoteItem } from "./promote";
import { stubEnricher } from "./enrichment";
import { ImportError } from "./errors";
import { createImportedStore } from "./imported-store";
import { createPendingStore } from "../pending-store";
import { drainSync } from "../sync";
import type { ImportedItem } from "../types";

const fileInput = document.getElementById("file") as HTMLInputElement;
const banner = document.getElementById("banner")!;
const summary = document.getElementById("summary")!;
const list = document.getElementById("list")!;

function showError(message: string): void {
  banner.textContent = message;
  banner.classList.add("show");
}

function clearError(): void {
  banner.textContent = "";
  banner.classList.remove("show");
}

fileInput.addEventListener("change", async () => {
  clearError();
  const file = fileInput.files?.[0];
  if (!file) return;

  try {
    const jsonText = await extractSavedPostsJson(file);
    const parsed = parseSavedPosts(jsonText);
    const items = toImportedItems(parsed);

    const importedStore = await createImportedStore();
    const pendingStore = await createPendingStore();
    const { toInsert, skippedExisting } = await reconcile(items, {
      async existingImported(u) { return Boolean(await importedStore.getByCanonicalUrl(u)); },
      async existingCapture(u) { return Boolean(await pendingStore.getByCanonicalUrl(u)); },
    });
    await importedStore.bulkPut(toInsert);

    const dormant = await importedStore.listByState("dormant");
    summary.textContent =
      `${dormant.length} in your backlog` +
      (skippedExisting ? ` · ${skippedExisting} already saved` : "");
    render(groupAndSort(dormant));
  } catch (err) {
    if (err instanceof ImportError) showError(err.message);
    else showError("Something went wrong reading that file.");
  }
});

function render(groups: AuthorGroup[]): void {
  list.textContent = "";
  for (const group of groups) {
    list.appendChild(renderGroup(group));
  }
}

function renderGroup(group: AuthorGroup): HTMLElement {
  const section = document.createElement("section");
  section.className = "group";

  const h2 = document.createElement("h2");
  h2.textContent = `@${group.author} — ${group.items.length} saved`;
  section.appendChild(h2);

  const bulk = document.createElement("div");
  bulk.className = "bulk";
  const keepAll = document.createElement("button");
  keepAll.textContent = "Keep all";
  const dismissAll = document.createElement("button");
  dismissAll.textContent = "Dismiss all";
  bulk.append(keepAll, dismissAll);
  section.appendChild(bulk);

  const ul = document.createElement("ul");
  for (const item of group.items) {
    ul.appendChild(renderItem(item));
  }
  section.appendChild(ul);

  keepAll.addEventListener("click", async () => {
    for (const item of group.items) await keep(item);
    section.remove();
  });
  dismissAll.addEventListener("click", () => {
    section.remove(); // dismissed items stay dormant in the store, just hidden
  });

  return section;
}

function renderItem(item: ImportedItem): HTMLElement {
  const li = document.createElement("li");

  const link = document.createElement("a");
  link.href = item.canonical_url || "#";
  link.textContent = item.parse_ok ? item.canonical_url : "(unreadable link — needs review)";
  link.target = "_blank";
  link.rel = "noopener";

  const keepBtn = document.createElement("button");
  keepBtn.textContent = "Keep";
  keepBtn.addEventListener("click", async () => {
    await keep(item);
    li.classList.add("kept");
    keepBtn.disabled = true;
  });

  const skipBtn = document.createElement("button");
  skipBtn.textContent = "Skip";
  skipBtn.addEventListener("click", () => li.remove());

  li.append(keepBtn, skipBtn, link);
  return li;
}

async function keep(item: ImportedItem): Promise<void> {
  const importedStore = await createImportedStore();
  const pendingStore = await createPendingStore();
  await promoteItem(item, {
    importedStore,
    pendingStore,
    enricher: stubEnricher,
    drain: () => { pendingStore && drainSync(pendingStore).catch(() => {}); },
    uuid: () => crypto.randomUUID(),
  });
}
```

- [ ] **Step 3: Add the import link to `index.html`**

In `index.html`, find the `<p>` inside `<main>` and add a link after it:

```html
      <p>Share a reel from Instagram and pick <strong>InSave</strong> to save it. Tag it later.</p>
      <p><a href="/import.html" style="color:#8ab4ff">Import your saved-reels backlog →</a></p>
```

- [ ] **Step 4: Add `import.html` to the Vite build inputs**

In `vite.config.ts`, add to the `input` object (after the `captured` entry):

```typescript
        importPage: resolve(__dirname, "import.html"),
```

- [ ] **Step 5: Type-check and build**

Run: `npx tsc --noEmit`
Expected: exit 0.
Run: `npm run build`
Expected: success; `dist/import.html` and `dist/index.html` exist at the dist root.

- [ ] **Step 6: Commit**

```bash
git add import.html src/import/triage-view.ts index.html vite.config.ts
git -c user.name="InSave" -c user.email="kgspune@gmail.com" commit -m "feat: triage UI page for backlog import"
```
(End the message body with the Co-Authored-By line.)

---

## Task 12: D1 schema + Worker columns

**Files:**
- Modify: `schema.sql`
- Modify: `worker/index.ts`

- [ ] **Step 1: Replace `schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS pending_capture (
  id            TEXT PRIMARY KEY,
  canonical_url TEXT,
  raw_payload   TEXT NOT NULL,
  captured_at   INTEGER NOT NULL,
  source        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  parse_ok      INTEGER NOT NULL DEFAULT 1,
  saved_at      INTEGER,
  title         TEXT,
  thumbnail     TEXT,
  description   TEXT
);

-- Dedupe key. Partial unique index so multiple parse_ok=false rows
-- (canonical_url = '') don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_url
  ON pending_capture (canonical_url)
  WHERE canonical_url <> '';
```

> For an existing remote DB, these new columns require `ALTER TABLE pending_capture ADD COLUMN ...` (documented in manual-verification). For local dev, re-run `npm run db:init` against a fresh local DB.

- [ ] **Step 2: Update `worker/index.ts`**

Replace the `WireRecord` interface and the `INSERT`/`bind` in `handleSync` with:

```typescript
interface WireRecord {
  id: string;
  canonical_url: string;
  raw_payload: string;
  captured_at: number;
  source: string;
  status: string;
  parse_ok: boolean;
  saved_at?: number;
  title?: string;
  thumbnail?: string;
  description?: string;
}
```

```typescript
  const stmt = env.DB.prepare(
    `INSERT INTO pending_capture
       (id, canonical_url, raw_payload, captured_at, source, status, parse_ok,
        saved_at, title, thumbnail, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );

  for (const r of records) {
    try {
      await stmt
        .bind(
          r.id, r.canonical_url, r.raw_payload, r.captured_at, r.source, r.status,
          r.parse_ok ? 1 : 0,
          r.saved_at ?? null, r.title ?? null, r.thumbnail ?? null, r.description ?? null,
        )
        .run();
      accepted.push(r.id);
    } catch {
      accepted.push(r.id);
    }
  }
```

(Leave the rest of `handleSync` — the JSON parse, the `accepted` array declaration, and the response — unchanged.)

- [ ] **Step 3: Type-check and re-init local D1**

Run: `npx tsc --noEmit`
Expected: exit 0.
Run: `npx wrangler d1 execute insave --local --file=schema.sql`
Expected: succeeds (creates the table fresh locally with the new columns). If it reports the table already exists without the new columns, that's the known local-migration caveat — note it and continue; tsc is the gate.

- [ ] **Step 4: Commit**

```bash
git add schema.sql worker/index.ts
git -c user.name="InSave" -c user.email="kgspune@gmail.com" commit -m "feat: D1 columns for saved_at and enrichment fields

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 13: Full test + build gate

**Files:** none (verification)

- [ ] **Step 1: Full unit suite**

Run: `npm test`
Expected: all pass — the 20 PRD01 tests plus the new import suites
(imported-store 5, parse 5, zip 3, normalize 3, reconcile 4, enrichment 1, promote 2, triage 3 = 26 new; **46 total**).

- [ ] **Step 2: Type-check + production build**

Run: `npm run build`
Expected: clean build; `dist/sw.js`, `dist/index.html`, `dist/captured.html`, `dist/import.html` all present at dist root.

- [ ] **Step 3: Commit any fixes** (only if Steps 1–2 surfaced issues)

```bash
git add -A
git -c user.name="InSave" -c user.email="kgspune@gmail.com" commit -m "test: green full suite + clean build with import"
```

---

## Task 14: Manual verification doc

**Files:**
- Modify: `docs/manual-verification.md`

- [ ] **Step 1: Append an import section to `docs/manual-verification.md`**

```markdown

## PRD02 Backlog Import (real Instagram export)

Requires a real "Download Your Information" export from Instagram.

### Setup
- Apply the new D1 columns. Fresh local DB: `wrangler d1 execute insave --local --file=schema.sql`.
  Existing remote DB: `wrangler d1 execute insave --file="ALTER TABLE pending_capture ADD COLUMN saved_at INTEGER; ALTER TABLE pending_capture ADD COLUMN title TEXT; ALTER TABLE pending_capture ADD COLUMN thumbnail TEXT; ALTER TABLE pending_capture ADD COLUMN description TEXT;"`

### Checklist (PRD §10)
- [ ] Upload the export `.zip` on `/import.html` → full backlog lists with NO network calls to Instagram (check devtools Network).
- [ ] Upload the extracted `saved_posts.json` directly → same result.
- [ ] Items are grouped by author and ordered by recency; counts per author shown.
- [ ] A malformed/wrong file shows the safe error banner, no crash.
- [ ] "Keep" / "Keep all from @author" promotes items; they appear in D1 with `source='import'` and `saved_at` set.
- [ ] Skipped/dismissed items are NOT in D1 and generate no reminders, but remain in the local backlog.
- [ ] Re-uploading the same export adds no duplicates ("N already saved" shown).
- [ ] Confirm the real export's `saved_posts.json` structure matches the parser; adjust `parse-saved-posts.ts` if Instagram changed field names.
```

- [ ] **Step 2: Commit**

```bash
git add docs/manual-verification.md
git -c user.name="InSave" -c user.email="kgspune@gmail.com" commit -m "docs: manual verification for backlog import

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** every PRD §10 acceptance item maps to a task (see spec §9). Upload+zero-requests → T5/T4/T3/T11; parse+normalize+dedupe → T4/T6/T7; safe error → T4 errors + T11 banner; auto-sort → T10; promote→tag-queue shape → T9; dormant/never-enriched → store + state rules; pluggable stub → T8 + T9 call site; re-import reconcile → T7.
- **Type consistency:** `ImportedItem`, `ParsedSavedItem`, `EnrichmentResult`, `ImportedStore`, `PendingStore`, `Enricher`, `PromoteDeps`, `ReconcileLookup`, `AuthorGroup`, and the `PendingCapture` extension are used identically across tasks. `toImportedItems(parsed, deps)`, `reconcile(incoming, lookup)`, `promote(item, deps)`, `groupAndSort(items)`, `extractSavedPostsJson(blob)`, `parseSavedPosts(text)` signatures match between definition and call sites (triage-view).
- **DB versioning:** single `openInsaveDB` (v2) owns both stores; pending-store keeps its interface so PRD01 code is untouched; existing 20 tests must stay green after Task 2.
- **No placeholders:** every code step is complete; the only external value is the remote D1 `ALTER TABLE` migration, documented with the exact command.
```