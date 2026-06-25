# PRD 05b — Collections UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the collections UI on top of 05a's data+sync foundation — a collections-home view, one-tap capture chips, create/rename/delete, and reel-move — without breaking the zero-tap capture path.

**Architecture:** Logic lives in four pure, headless-tested helpers (`drainAll`, `recentChips`, `planCollectionDelete`, `capturedRedirectUrl`); the DOM views (`collections-home`, `collection-view`, `captured-view`, `collection-picker` sheet, `reel-card`) are thin and verified by `tsc` + `vite build` + manual checks. `index.html` becomes the collections home. The capture surface is progressive enhancement over the SW's already-durable "Saved" write.

**Tech Stack:** TypeScript, IndexedDB via `idb`, Vite, Vitest (node env, `fake-indexeddb`). No new dependencies.

## Global Constraints

- **No new runtime dependencies.** Use only what's already in `package.json`.
- **Zero-tap capture is sacred.** The reel is persisted to "Saved" inside the SW before the redirect; chips/UI must never gate, delay, or condition the save. The capture save path (`capture.ts`, `handleShare`'s save call) must stay behaviourally unchanged.
- **`collection_id` null/undefined ≡ the user's "Saved" collection.** Read everywhere by this rule. Opening "Saved" uses `listByCollection(saved.id, saved.id)` which includes null-collection items.
- **Collection views show only active reels:** filter out `status === "dismissed"` in the view layer. Do NOT change 05a's tested store methods.
- **"Delete reels too" = `dismiss`** (status→dismissed, syncs via `/api/sync`). No hard-delete, no new endpoint.
- **"Saved" is undeletable** — `collectionsStore.remove` already throws on the default; never offer rename/delete on the default card.
- **Test env is `node`** (`vitest.config.ts`): unit tests are headless only. DOM modules are verified with `npx tsc --noEmit` + `npx vite build` + `docs/manual-verification.md`.
- **Run `npx tsc --noEmit && npx vitest run` at each task's verify step.** Baseline at branch HEAD: 137 tests green.
- Commit message trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: `drainAll` — combined sync wiring

**Files:**
- Create: `src/drain-all.ts`
- Test: `tests/drain-all.test.ts`

**Interfaces:**
- Consumes: `drainSync(store, fetchFn?)` from `./sync`; `drainCollections(store, fetchFn?)` from `./collections-sync`; `PendingStore` from `./pending-store`; `CollectionsStore` from `./collections-store`.
- Produces: `drainAll(pending: PendingStore, collections: Pick<CollectionsStore, "listUnsynced" | "markSynced">, fetchFn?: typeof fetch): Promise<void>` — runs both rails; one failing never prevents or propagates from the other.

- [ ] **Step 1: Write the failing test** — `tests/drain-all.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import { drainAll } from "../src/drain-all";

function pendingStub(unsynced: { id: string }[]) {
  return { listUnsynced: vi.fn(async () => unsynced), markSynced: vi.fn(async () => {}) };
}
function collectionsStub(unsynced: { id: string }[]) {
  return { listUnsynced: vi.fn(async () => unsynced), markSynced: vi.fn(async () => {}) };
}

describe("drainAll", () => {
  it("drains both the pending and collections rails", async () => {
    const pending = pendingStub([{ id: "p1" }]);
    const collections = collectionsStub([{ id: "c1" }]);
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ accepted: ["p1", "c1"] }), { status: 200 });
    });
    await drainAll(pending as never, collections as never, fetchFn as unknown as typeof fetch);
    expect(urls).toContain("/api/sync");
    expect(urls).toContain("/api/collections");
  });

  it("a failure on one rail does not prevent the other or throw", async () => {
    const pending = { listUnsynced: vi.fn(async () => { throw new Error("boom"); }), markSynced: vi.fn() };
    const collections = collectionsStub([{ id: "c1" }]);
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ accepted: ["c1"] }), { status: 200 }));
    await drainAll(pending as never, collections as never, fetchFn as unknown as typeof fetch);
    expect(collections.listUnsynced).toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledWith("/api/collections", expect.anything());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/drain-all.test.ts`
Expected: FAIL — cannot find module `../src/drain-all`.

- [ ] **Step 3: Implement `src/drain-all.ts`**

```ts
import { drainSync } from "./sync";
import { drainCollections } from "./collections-sync";
import type { PendingStore } from "./pending-store";
import type { CollectionsStore } from "./collections-store";

// Runs both device-owned sync rails. Each is guarded so an offline/transient
// failure on one never blocks or propagates from the other (mirrors the
// fire-and-forget discipline of drainSync/drainCollections).
export async function drainAll(
  pending: PendingStore,
  collections: Pick<CollectionsStore, "listUnsynced" | "markSynced">,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  try { await drainSync(pending, fetchFn); } catch { /* retry next trigger */ }
  try { await drainCollections(collections, fetchFn); } catch { /* retry next trigger */ }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/drain-all.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all green (137 + 2 = 139).

- [ ] **Step 6: Commit**

```bash
git add src/drain-all.ts tests/drain-all.test.ts
git commit -m "feat(prd05b): drainAll — combined pending+collections sync wiring"
```

---

### Task 2: `collection-picker` — `recentChips` helper + picker sheet

**Files:**
- Create: `src/collection-picker.ts`
- Test: `tests/collection-picker.test.ts`

**Interfaces:**
- Consumes: `Collection` from `./types`.
- Produces:
  - `recentChips(collections: Collection[], cap?: number): Collection[]` — non-default collections, newest-created first, capped (default 5).
  - `pickerSheet(collections: Collection[], opts: { exclude?: string; onPick: (collectionId: string) => void }): HTMLElement` — a tap-to-pick list element (thin DOM, not unit-tested).

- [ ] **Step 1: Write the failing test** — `tests/collection-picker.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { recentChips } from "../src/collection-picker";
import type { Collection } from "../src/types";

function col(over: Partial<Collection>): Collection {
  return { id: "x", user_id: "u", name: "X", created_at: 0, is_default: false, synced: true, ...over };
}

describe("recentChips", () => {
  it("excludes the default and orders newest-created first", () => {
    const cols = [
      col({ id: "s", name: "Saved", is_default: true, created_at: 1 }),
      col({ id: "a", name: "A", created_at: 10 }),
      col({ id: "b", name: "B", created_at: 30 }),
      col({ id: "c", name: "C", created_at: 20 }),
    ];
    expect(recentChips(cols).map((c) => c.name)).toEqual(["B", "C", "A"]);
  });

  it("caps the result (default 5)", () => {
    const cols = Array.from({ length: 8 }, (_, i) => col({ id: `c${i}`, name: `C${i}`, created_at: i }));
    expect(recentChips(cols)).toHaveLength(5);
    expect(recentChips(cols, 2)).toHaveLength(2);
  });

  it("returns nothing when only the default exists", () => {
    expect(recentChips([col({ id: "s", is_default: true })])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/collection-picker.test.ts`
Expected: FAIL — cannot find module `../src/collection-picker`.

- [ ] **Step 3: Implement `src/collection-picker.ts`**

```ts
import type { Collection } from "./types";

// Bounded, ordered chip set for the capture surface: existing (non-default)
// collections, newest-created first, capped. "Saved" is excluded — a freshly
// captured reel is already in Saved by default.
export function recentChips(collections: Collection[], cap = 5): Collection[] {
  return collections
    .filter((c) => !c.is_default)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, cap);
}

export interface PickerOptions {
  exclude?: string;
  onPick: (collectionId: string) => void;
}

// Tap-to-pick list of collections for the Move action. Thin DOM; verified via
// manual verification, not unit tests (node test env has no DOM).
export function pickerSheet(collections: Collection[], opts: PickerOptions): HTMLElement {
  const sheet = document.createElement("div");
  sheet.className = "picker-sheet";
  for (const c of collections) {
    if (c.id === opts.exclude) continue;
    const btn = document.createElement("button");
    btn.className = "picker-option";
    btn.textContent = c.name;
    btn.addEventListener("click", () => opts.onPick(c.id));
    sheet.appendChild(btn);
  }
  return sheet;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/collection-picker.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all green (142).

- [ ] **Step 6: Commit**

```bash
git add src/collection-picker.ts tests/collection-picker.test.ts
git commit -m "feat(prd05b): collection-picker — recentChips + picker sheet"
```

---

### Task 3: `planCollectionDelete` — pure delete planner

**Files:**
- Create: `src/collection-delete.ts`
- Test: `tests/collection-delete.test.ts`

**Interfaces:**
- Consumes: `PendingCapture` from `./types`.
- Produces:
  - `type DeleteChoice = "move" | "dismiss" | "cancel"`
  - `interface DeleteOp { kind: "move" | "dismiss"; id: string; to?: string }`
  - `interface DeletePlan { ops: DeleteOp[]; removeCollection: boolean }`
  - `planCollectionDelete(members: PendingCapture[], savedId: string, choice: DeleteChoice): DeletePlan`

- [ ] **Step 1: Write the failing test** — `tests/collection-delete.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { planCollectionDelete } from "../src/collection-delete";
import type { PendingCapture } from "../src/types";

function rec(id: string): PendingCapture {
  return { id, canonical_url: "u", raw_payload: "{}", captured_at: 0, source: "import", status: "tagged", parse_ok: true, synced: true };
}

describe("planCollectionDelete", () => {
  it("move: re-homes every member to Saved, then removes the collection", () => {
    const plan = planCollectionDelete([rec("a"), rec("b")], "saved-id", "move");
    expect(plan.ops).toEqual([
      { kind: "move", id: "a", to: "saved-id" },
      { kind: "move", id: "b", to: "saved-id" },
    ]);
    expect(plan.removeCollection).toBe(true);
  });

  it("dismiss: dismisses every member, then removes the collection", () => {
    const plan = planCollectionDelete([rec("a")], "saved-id", "dismiss");
    expect(plan.ops).toEqual([{ kind: "dismiss", id: "a" }]);
    expect(plan.removeCollection).toBe(true);
  });

  it("empty collection: no ops but still removes", () => {
    expect(planCollectionDelete([], "saved-id", "move")).toEqual({ ops: [], removeCollection: true });
  });

  it("cancel: no ops, does not remove", () => {
    expect(planCollectionDelete([rec("a")], "saved-id", "cancel")).toEqual({ ops: [], removeCollection: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/collection-delete.test.ts`
Expected: FAIL — cannot find module `../src/collection-delete`.

- [ ] **Step 3: Implement `src/collection-delete.ts`**

```ts
import type { PendingCapture } from "./types";

export type DeleteChoice = "move" | "dismiss" | "cancel";

export interface DeleteOp {
  kind: "move" | "dismiss";
  id: string;
  to?: string; // present only for kind === "move"
}

export interface DeletePlan {
  ops: DeleteOp[];
  removeCollection: boolean;
}

// Pure planner for deleting a collection. `members` are the collection's
// non-dismissed reels. "move" re-homes them to Saved; "dismiss" removes them
// too (recoverable); "cancel" is a no-op. Empty collections still remove.
export function planCollectionDelete(
  members: PendingCapture[],
  savedId: string,
  choice: DeleteChoice,
): DeletePlan {
  if (choice === "cancel") return { ops: [], removeCollection: false };
  const ops: DeleteOp[] =
    choice === "move"
      ? members.map((m) => ({ kind: "move", id: m.id, to: savedId }))
      : members.map((m) => ({ kind: "dismiss", id: m.id }));
  return { ops, removeCollection: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/collection-delete.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all green (146).

- [ ] **Step 6: Commit**

```bash
git add src/collection-delete.ts tests/collection-delete.test.ts
git commit -m "feat(prd05b): planCollectionDelete — pure delete planner"
```

---

### Task 4: `capturedRedirectUrl` + SW wiring (id plumbing, SHELL, drainAll)

**Files:**
- Create: `src/captured-url.ts`
- Test: `tests/captured-url.test.ts`
- Modify: `src/sw.ts`

**Interfaces:**
- Consumes: `CaptureResult` (already returned by `handleCapture`; `.record?.id` is optional).
- Produces: `capturedRedirectUrl(status: string, id?: string): string`.

- [ ] **Step 1: Write the failing test** — `tests/captured-url.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { capturedRedirectUrl } from "../src/captured-url";

describe("capturedRedirectUrl", () => {
  it("appends the record id when present", () => {
    expect(capturedRedirectUrl("saved", "abc")).toBe("/captured.html?status=saved&id=abc");
  });

  it("omits the id when absent (e.g. error path)", () => {
    expect(capturedRedirectUrl("error")).toBe("/captured.html?status=error");
  });

  it("encodes the id", () => {
    expect(capturedRedirectUrl("dup", "a b/c")).toBe("/captured.html?status=dup&id=a%20b%2Fc");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/captured-url.test.ts`
Expected: FAIL — cannot find module `../src/captured-url`.

- [ ] **Step 3: Implement `src/captured-url.ts`**

```ts
// Builds the post-capture redirect URL. The record id is appended only when
// present (every status except "error") so captured.html can offer collection
// chips that re-target the just-saved reel.
export function capturedRedirectUrl(status: string, id?: string): string {
  return `/captured.html?status=${status}${id ? `&id=${encodeURIComponent(id)}` : ""}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/captured-url.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the SW** — edit `src/sw.ts`

Add imports after the existing imports (top of file):

```ts
import { createCollectionsStore } from "./collections-store";
import { drainAll } from "./drain-all";
import { capturedRedirectUrl } from "./captured-url";
```

Add `/collection.html` to the SHELL array:

```ts
const SHELL = ["/", "/index.html", "/captured.html", "/collection.html", "/tag.html", "/review.html", "/manifest.webmanifest"];
```

Bump the cache version (any SW behaviour change must purge the old cache):

```ts
const CACHE = "insave-shell-v3";
```

Add a shared collections-store promise next to `storePromise`:

```ts
const storePromise = createPendingStore();
const collectionsPromise = createCollectionsStore();
```

In `activate`, replace the opportunistic `drainSync` line:

```ts
      const store = await storePromise;
      await drainSync(store).catch(() => {}); // opportunistic drain; never block activation
```

with:

```ts
      const store = await storePromise;
      const collections = await collectionsPromise;
      await drainAll(store, collections).catch(() => {}); // opportunistic drain; never block activation
```

In `handleShare`, replace the body that builds `status` and redirects:

```ts
  let status: string;
  try {
    const store = await storePromise;
    const result = await handleCapture(payload, store);
    status = result.status;
    // fire-and-forget sync; never blocks the redirect
    drainSync(store).catch(() => {});
  } catch {
    status = "error";
  }

  return Response.redirect(`/captured.html?status=${status}`, 303);
```

with:

```ts
  let status: string;
  let id: string | undefined;
  try {
    const store = await storePromise;
    const result = await handleCapture(payload, store);
    status = result.status;
    id = result.record?.id;
    const collections = await collectionsPromise;
    // fire-and-forget sync of both rails; never blocks the redirect
    drainAll(store, collections).catch(() => {});
  } catch {
    status = "error";
  }

  return Response.redirect(capturedRedirectUrl(status, id), 303);
```

> Note: the `drainSync` import in `sw.ts` is still used elsewhere? It is not after this change — remove the now-unused `import { drainSync } from "./sync";` line to keep tsc's `noUnusedLocals` happy. (If tsc reports it still used, leave it.)

- [ ] **Step 6: Typecheck + build + full suite**

Run: `npx tsc --noEmit && npx vitest run && npx vite build`
Expected: tsc clean; all green (149); build succeeds (SW bundles `drain-all`/`collections-store`).

- [ ] **Step 7: Commit**

```bash
git add src/captured-url.ts tests/captured-url.test.ts src/sw.ts
git commit -m "feat(prd05b): capture redirect carries record id; SW drains both rails"
```

---

### Task 5: Capture-chip surface — `captured.html` + `captured-view.ts`

**Files:**
- Modify: `captured.html`
- Create: `src/captured-view.ts`

**Interfaces:**
- Consumes: `recentChips` (Task 2), `drainAll` (Task 1), `createCollectionsStore`, `createPendingStore`, `pending-store.move`.
- Produces: progressive enhancement only — no exports consumed by other tasks.

No unit test (DOM + node test env). Verified by `tsc` + `vite build` + manual verification (Task 8).

- [ ] **Step 1: Update `captured.html`**

Replace the whole file with (adds `#chips`, extends the timer to 4000ms, exposes `__insaveCancelReturn`, adds the module script + chip styles):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>InSave</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #111; color: #eee; }
      .toast {
        position: fixed; left: 50%; bottom: 80px; transform: translateX(-50%);
        background: #222; color: #fff; padding: 14px 20px; border-radius: 10px;
        font-size: 16px; box-shadow: 0 4px 16px rgba(0,0,0,.4); opacity: 0;
        transition: opacity .2s; max-width: 90vw; text-align: center;
      }
      .toast.show { opacity: 1; }
      .chips { position: fixed; left: 0; right: 0; bottom: 24px; display: flex;
               flex-wrap: wrap; justify-content: center; gap: 8px; padding: 0 16px; }
      .chips .chip { background: #1e2a3a; color: #cfe0ff; border: 1px solid #2c3e57;
                     border-radius: 16px; padding: 6px 14px; font-size: 15px; }
      .chips .new-in-app { color: #8ab4ff; align-self: center; text-decoration: none; font-size: 14px; }
    </style>
  </head>
  <body>
    <div id="toast" class="toast" role="status" aria-live="polite"></div>
    <div id="chips" class="chips"></div>
    <!-- Inline (no imports) so the confirmation renders offline from the SW shell
         cache even if the enhancement bundle isn't cached yet. -->
    <script>
      var MESSAGES = {
        saved: "Saved. Pick a collection or keep in Saved.",
        dup: "Already in InSave.",
        unparsed: "Saved — needs a look later.",
        error: "Couldn't save, try again."
      };
      var captureStatus = new URLSearchParams(location.search).get("status") || "saved";
      var toast = document.getElementById("toast");
      toast.textContent = MESSAGES[captureStatus] || MESSAGES.saved;
      requestAnimationFrame(function () { toast.classList.add("show"); });

      // Auto-dismiss and return the user to where they came from. Longer beat so
      // there's time to glance/tap a chip; doing nothing still lands in "Saved".
      var DISMISS_MS = captureStatus === "error" ? 2600 : 4000;
      var t = window.setTimeout(function () {
        toast.classList.remove("show");
        window.setTimeout(function () {
          if (history.length > 1) history.back();
        }, 250);
      }, DISMISS_MS);

      // The enhancement module calls this when the user taps a chip, so the auto
      // return doesn't race the move.
      window.__insaveCancelReturn = function () { window.clearTimeout(t); };

      toast.addEventListener("click", function () {
        if (history.length > 1) history.back();
      });
    </script>
    <script type="module" src="/src/captured-view.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Implement `src/captured-view.ts`**

```ts
import { createCollectionsStore } from "./collections-store";
import { createPendingStore } from "./pending-store";
import { drainAll } from "./drain-all";
import { recentChips } from "./collection-picker";

declare global {
  interface Window { __insaveCancelReturn?: () => void }
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const id = params.get("id");
  const status = params.get("status") ?? "saved";
  // Nothing to enhance: no saved record (e.g. error) or an old SW that didn't pass an id.
  if (!id || status === "error") return;

  const chipsEl = document.getElementById("chips");
  const toastEl = document.getElementById("toast");
  if (!chipsEl) return;

  const collectionsStore = await createCollectionsStore();
  const pendingStore = await createPendingStore();
  const chips = recentChips(await collectionsStore.list());

  for (const c of chips) {
    const btn = document.createElement("button");
    btn.className = "chip";
    btn.textContent = c.name;
    btn.addEventListener("click", async () => {
      window.__insaveCancelReturn?.();           // we control the return now
      await pendingStore.move(id, c.id);          // re-target the already-saved reel
      if (toastEl) toastEl.textContent = `Moved to ${c.name} ✓`;
      drainAll(pendingStore, collectionsStore).catch(() => {});
      window.setTimeout(() => { if (history.length > 1) history.back(); }, 800);
    });
    chipsEl.appendChild(btn);
  }

  // Create-in-app path (no inline create on the hot path; PRD §12 lean).
  const newLink = document.createElement("a");
  newLink.className = "new-in-app";
  newLink.href = "/index.html";
  newLink.textContent = "+ New in app";
  chipsEl.appendChild(newLink);
}

void main();
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npx vite build`
Expected: tsc clean; build emits `captured-view` bundle.

- [ ] **Step 4: Commit**

```bash
git add captured.html src/captured-view.ts
git commit -m "feat(prd05b): capture-chip surface (progressive enhancement on captured.html)"
```

---

### Task 6: Collections home — `index.html` + `collections-home.ts`

**Files:**
- Modify: `index.html`
- Create: `src/collections-home.ts`

**Interfaces:**
- Consumes: `createCollectionsStore` (`list`/`create`/`rename`/`remove`), `createPendingStore` (`listByCollection`/`move`/`dismiss`), `drainAll`, `planCollectionDelete` + `DeleteChoice`.
- Produces: the primary view; no exports consumed by other tasks.

No unit test (DOM + node test env). Verified by `tsc` + `vite build` + manual verification (Task 8).

- [ ] **Step 1: Update `index.html`** — replace the whole file:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#111111" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <title>InSave — Collections</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #111; color: #eee; }
      header { padding: 20px 20px 8px; }
      h1 { font-size: 1.4rem; margin: 0 0 8px; }
      nav { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; }
      nav a { color: #8ab4ff; text-decoration: none; font-size: 14px; }
      .actions { padding: 8px 20px 4px; }
      button { background: #2a2a2a; color: #eee; border: 1px solid #3a3a3a; border-radius: 6px; padding: 6px 12px; font-size: 14px; }
      .col-card { display: flex; align-items: center; gap: 10px; text-decoration: none; color: #eee;
                  border-top: 1px solid #222; padding: 14px 20px; }
      .col-name { font-weight: 600; flex: 1; }
      .col-count { color: #888; font-variant-numeric: tabular-nums; }
      .col-card .col-rename, .col-card .col-delete { font-size: 12px; padding: 4px 8px; }
      .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex;
                 align-items: flex-end; justify-content: center; }
      .sheet { background: #1b1b1b; border: 1px solid #333; border-radius: 12px 12px 0 0;
               width: 100%; max-width: 28rem; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
      .sheet p { margin: 0 0 6px; color: #ccc; }
      .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
               background: #222; border: 1px solid #3a3a3a; border-radius: 8px; padding: 10px 16px; display: none; }
      .toast.show { display: block; }
    </style>
  </head>
  <body>
    <header>
      <h1>InSave</h1>
      <nav>
        <a href="/import.html">Import</a>
        <a href="/review.html">Review</a>
        <button id="enable-reminders">Enable reminders</button>
      </nav>
    </header>
    <div class="actions"><button id="new-collection">+ New collection</button></div>
    <div id="list"></div>
    <div id="toast" class="toast" role="status"></div>
    <script type="module" src="/src/push-enable.ts"></script>
    <script type="module" src="/src/register-sw.ts"></script>
    <script type="module" src="/src/collections-home.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Implement `src/collections-home.ts`**

```ts
import { createCollectionsStore } from "./collections-store";
import { createPendingStore } from "./pending-store";
import { drainAll } from "./drain-all";
import { planCollectionDelete, type DeleteChoice } from "./collection-delete";
import type { Collection, PendingCapture } from "./types";

const listEl = document.getElementById("list")!;
const newBtn = document.getElementById("new-collection") as HTMLButtonElement | null;

// Minimal three-way choice modal for a non-empty delete. Resolves the choice.
function chooseDeleteAction(name: string, count: number): Promise<DeleteChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const sheet = document.createElement("div");
    sheet.className = "sheet";
    const p = document.createElement("p");
    p.textContent = `Delete "${name}" (${count} reel${count === 1 ? "" : "s"})?`;
    sheet.appendChild(p);
    const opts: [string, DeleteChoice][] = [
      [`Move ${count} to Saved`, "move"],
      ["Delete the reels too", "dismiss"],
      ["Cancel", "cancel"],
    ];
    for (const [label, choice] of opts) {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", () => { overlay.remove(); resolve(choice); });
      sheet.appendChild(b);
    }
    overlay.addEventListener("click", (e) => { if (e.target === overlay) { overlay.remove(); resolve("cancel"); } });
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
  });
}

async function main(): Promise<void> {
  const collectionsStore = await createCollectionsStore();
  const pendingStore = await createPendingStore();
  const saved = (await collectionsStore.list()).find((c) => c.is_default)!;
  drainAll(pendingStore, collectionsStore).catch(() => {});

  const drain = () => { drainAll(pendingStore, collectionsStore).catch(() => {}); };

  async function activeMembers(colId: string): Promise<PendingCapture[]> {
    const all = await pendingStore.listByCollection(colId, saved.id);
    return all.filter((r) => r.status !== "dismissed");
  }

  async function render(): Promise<void> {
    listEl.replaceChildren();
    const collections = await collectionsStore.list();
    for (const c of collections) {
      const count = (await activeMembers(c.id)).length;
      listEl.appendChild(renderCard(c, count));
    }
  }

  function renderCard(c: Collection, count: number): HTMLElement {
    const card = document.createElement("a");
    card.className = "col-card";
    card.href = `/collection.html?id=${encodeURIComponent(c.id)}`;

    const name = document.createElement("span");
    name.className = "col-name";
    name.textContent = c.name;
    card.appendChild(name);

    const meta = document.createElement("span");
    meta.className = "col-count";
    meta.textContent = String(count);
    card.appendChild(meta);

    if (!c.is_default) {
      const rename = document.createElement("button");
      rename.className = "col-rename";
      rename.textContent = "Rename";
      rename.addEventListener("click", async (e) => {
        e.preventDefault();
        const next = prompt("Rename collection", c.name)?.trim();
        if (next) { await collectionsStore.rename(c.id, next); drain(); await render(); }
      });
      card.appendChild(rename);

      const del = document.createElement("button");
      del.className = "col-delete";
      del.textContent = "Delete";
      del.addEventListener("click", async (e) => {
        e.preventDefault();
        await handleDelete(c);
      });
      card.appendChild(del);
    }
    return card;
  }

  async function handleDelete(c: Collection): Promise<void> {
    const members = await activeMembers(c.id);
    const choice: DeleteChoice = members.length === 0 ? "move" : await chooseDeleteAction(c.name, members.length);
    const plan = planCollectionDelete(members, saved.id, choice);
    for (const op of plan.ops) {
      if (op.kind === "move") await pendingStore.move(op.id, op.to!);
      else await pendingStore.dismiss(op.id);
    }
    if (plan.removeCollection) await collectionsStore.remove(c.id);
    drain();
    await render();
  }

  newBtn?.addEventListener("click", async () => {
    const name = prompt("New collection name")?.trim();
    if (!name) return;
    await collectionsStore.create(name);
    drain();
    await render();
  });

  await render();
}

void main();
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npx vite build`
Expected: tsc clean; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add index.html src/collections-home.ts
git commit -m "feat(prd05b): collections home (list + counts + create/rename/delete)"
```

---

### Task 7: Collection detail — `collection.html` + `collection-view.ts` + `reel-card.ts`

**Files:**
- Create: `collection.html`
- Create: `src/reel-card.ts`
- Create: `src/collection-view.ts`

**Interfaces:**
- Consumes: `createCollectionsStore`, `createPendingStore` (`listByCollection`/`move`), `drainAll`, `pickerSheet` (Task 2).
- Produces: `renderReelCard(item: PendingCapture): HTMLElement` and `authorLabel(item): string` from `./reel-card` (reused by 05c later).

No unit test (DOM + node test env). Verified by `tsc` + `vite build` + manual verification (Task 8).

- [ ] **Step 1: Create `src/reel-card.ts`** (factored from the existing `tag-view`/`review-view` card)

```ts
import type { PendingCapture } from "./types";

export function authorLabel(item: PendingCapture): string {
  if (item.author) return "@" + item.author;
  try {
    return new URL(item.canonical_url).host;
  } catch {
    return "saved reel";
  }
}

// Shared reel card: meta (author + media badge), caption, link-out. Action
// controls (e.g. a Move button) are appended by the caller.
export function renderReelCard(item: PendingCapture): HTMLElement {
  const card = document.createElement("section");
  card.className = "card";

  const meta = document.createElement("div");
  meta.className = "meta";
  const author = document.createElement("span");
  author.className = "author";
  author.textContent = authorLabel(item);
  meta.appendChild(author);
  if (item.media_type) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = item.media_type;
    meta.appendChild(badge);
  }
  card.appendChild(meta);

  if (item.description) {
    const cap = document.createElement("p");
    cap.className = "caption";
    cap.textContent = item.description;
    card.appendChild(cap);
  }

  const link = document.createElement("a");
  link.className = "link";
  link.href = item.canonical_url || "#";
  link.textContent = item.parse_ok ? "Open in Instagram ↗" : "(unreadable link — needs review)";
  link.target = "_blank";
  link.rel = "noopener";
  card.appendChild(link);

  return card;
}
```

- [ ] **Step 2: Create `collection.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#111111" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <title>InSave — Collection</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #111; color: #eee; }
      header { padding: 20px; }
      h1 { font-size: 1.3rem; margin: 0 0 8px; }
      header a { color: #8ab4ff; text-decoration: none; }
      .empty { padding: 40px 20px; text-align: center; color: #888; display: none; }
      .empty.show { display: block; }
      .card { border-top: 1px solid #222; padding: 14px 20px; }
      .card .meta { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
      .card .author { font-weight: 600; }
      .badge { font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
               background: #2a2a2a; border: 1px solid #3a3a3a; border-radius: 4px; padding: 1px 6px; color: #bbb; }
      .card a.link { color: #8ab4ff; text-decoration: none; word-break: break-all; }
      .card .caption { color: #ccc; margin: 6px 0; }
      .card button { background: #2a2a2a; color: #eee; border: 1px solid #3a3a3a; border-radius: 6px; padding: 6px 12px; font-size: 14px; margin-top: 8px; }
      .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: flex-end; justify-content: center; }
      .picker-sheet { background: #1b1b1b; border: 1px solid #333; border-radius: 12px 12px 0 0;
                      width: 100%; max-width: 28rem; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
      .picker-option { background: #2a2a2a; color: #eee; border: 1px solid #3a3a3a; border-radius: 6px; padding: 10px 12px; font-size: 15px; text-align: left; }
    </style>
  </head>
  <body>
    <header>
      <h1 id="title">Collection</h1>
      <a href="/">← Collections</a>
    </header>
    <div id="empty" class="empty">Nothing here yet.</div>
    <div id="list"></div>
    <script type="module" src="/src/collection-view.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Register `collection.html` as a Vite build entry** — edit `vite.config.ts`

`vite.config.ts` uses an explicit `build.rollupOptions.input` map, so an undeclared HTML page is silently omitted from `dist/`. Add the `collection` entry:

```ts
      input: {
        main: resolve(__dirname, "index.html"),
        captured: resolve(__dirname, "captured.html"),
        collection: resolve(__dirname, "collection.html"),
        importPage: resolve(__dirname, "import.html"),
        tag: resolve(__dirname, "tag.html"),
        review: resolve(__dirname, "review.html"),
        sw: resolve(__dirname, "src/sw.ts"),
      },
```

(Also drop the now-stale `// captured.html uses an inlined script (no module entry needed)` comment — captured.html now also loads a module, bundled via the `captured` entry.)

- [ ] **Step 4: Implement `src/collection-view.ts`**

```ts
import { createCollectionsStore } from "./collections-store";
import { createPendingStore } from "./pending-store";
import { drainAll } from "./drain-all";
import { renderReelCard } from "./reel-card";
import { pickerSheet } from "./collection-picker";
import type { Collection, PendingCapture } from "./types";

const titleEl = document.getElementById("title")!;
const listEl = document.getElementById("list")!;
const emptyEl = document.getElementById("empty")!;

async function main(): Promise<void> {
  const collectionsStore = await createCollectionsStore();
  const pendingStore = await createPendingStore();
  const collections = await collectionsStore.list();
  const saved = collections.find((c) => c.is_default)!;
  const id = new URLSearchParams(location.search).get("id") ?? saved.id;
  const current: Collection = collections.find((c) => c.id === id) ?? saved;
  titleEl.textContent = current.name;
  drainAll(pendingStore, collectionsStore).catch(() => {});

  const members = (await pendingStore.listByCollection(current.id, saved.id))
    .filter((r) => r.status !== "dismissed");
  if (members.length === 0) {
    emptyEl.classList.add("show");
    return;
  }
  for (const item of members) listEl.appendChild(card(item));

  function card(item: PendingCapture): HTMLElement {
    const el = renderReelCard(item);
    const move = document.createElement("button");
    move.textContent = "Move";
    move.addEventListener("click", () => openPicker(item, el));
    el.appendChild(move);
    return el;
  }

  function openPicker(item: PendingCapture, el: HTMLElement): void {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const sheet = pickerSheet(collections, {
      exclude: current.id,
      onPick: async (target) => {
        overlay.remove();
        await pendingStore.move(item.id, target);
        drainAll(pendingStore, collectionsStore).catch(() => {});
        el.remove();
        if (listEl.children.length === 0) emptyEl.classList.add("show");
      },
    });
    overlay.appendChild(sheet);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }
}

void main();
```

- [ ] **Step 5: Typecheck + build**

Run: `npx tsc --noEmit && npx vite build`
Expected: tsc clean; build emits `dist/collection.html` + the `collection-view` bundle.

- [ ] **Step 6: Commit**

```bash
git add collection.html src/reel-card.ts src/collection-view.ts vite.config.ts
git commit -m "feat(prd05b): collection detail view + shared reel-card + move picker"
```

---

### Task 8: Manual-verification docs + final verification

**Files:**
- Modify: `docs/manual-verification.md`

No code; ties the release together and documents the DOM behaviour the headless suite can't cover.

- [ ] **Step 1: Confirm the build emits all pages** (the `collection` entry was added in Task 7)

Run: `npx vite build`
Expected: `dist/` includes `index.html`, `captured.html`, and `collection.html`.

- [ ] **Step 2: Append the PRD 05b section to `docs/manual-verification.md`**

```markdown
## PRD 05b — Collections UI

No schema change (05a already added the column/table). Apply the 05a remote
migration first if not already done.

### Checklist
- [ ] Open `/` → the collections home lists "Saved" first with a reel count; Import / Review / Enable-reminders links still work.
- [ ] Tap **+ New collection**, name it → it appears in the list (count 0).
- [ ] Open a collection → its reels list with author/badge/caption/link-out; "Saved" also shows reels captured with no collection (null-is-Saved).
- [ ] On a reel, tap **Move** → pick another collection → the reel leaves this list; open the target → it's there. In D1 its `collection_id` updated; reminder columns unchanged.
- [ ] **Rename** a non-default collection → the new name shows and persists after reload.
- [ ] **Delete** a non-empty collection → choose **Move to Saved** → reels appear under "Saved", collection gone. Repeat with **Delete the reels too** → reels gone from all views (status=dismissed in D1), collection gone.
- [ ] "Saved" shows no rename/delete affordance and cannot be deleted.
- [ ] **Capture zero-tap:** share a reel from Instagram, do nothing → toast shows, auto-returns; the reel is in "Saved".
- [ ] **Capture one-tap:** share a reel, tap a collection chip on the captured screen → toast flips to "Moved to X ✓", returns; the reel is in X (not Saved).
- [ ] **Capture offline:** with network off, share a reel → it still saves to "Saved" (chips may not appear; that's expected).
- [ ] After any change, with network on, confirm `/api/sync` and `/api/collections` received the updates (collection list + `collection_id`s present in D1).
```

- [ ] **Step 3: Final verification**

Run: `npx tsc --noEmit && npx vitest run && npx vite build`
Expected: tsc clean; all green (137 baseline + 12 new = 149: drain-all 2, collection-picker 3, collection-delete 4, captured-url 3); build succeeds with `dist/collection.html`.

> Test-count note: the exact total is whatever `vitest run` reports; the point is **zero failures** and the four new headless suites (drain-all, collection-picker, collection-delete, captured-url) present. Do not hand-tune the number.

- [ ] **Step 4: Commit**

```bash
git add docs/manual-verification.md
git commit -m "docs(prd05b): manual-verification checklist for collections UI"
```

---

## Final verification (after all tasks)

- [ ] `npx tsc --noEmit` — clean.
- [ ] `npx vitest run` — all green (137 baseline + 12 new headless across drain-all/collection-picker/collection-delete/captured-url).
- [ ] `npx vite build` — succeeds; `dist/` includes `index.html`, `captured.html`, `collection.html` and their bundles.
- [ ] Spec acceptance (§7) re-read against the diff. Deferred items (cleanup view C, backlog picker D) explicitly NOT in this plan.
- [ ] Zero-tap proof: `capture.ts` and the save call in `handleShare` are behaviourally unchanged; capture tests still green.

## Spec coverage map

| Spec §7 / acceptance | Task |
|---|---|
| Create + name collections; "Saved" always exists, undeletable | 6 (create/rename/delete; default guarded) |
| Primary view is collections; open one lists its reels | 6 (home), 7 (detail) |
| Zero-tap capture → "Saved" | 4 (id plumbing, save path unchanged), 5 |
| One-tap capture chip → collection | 2 (recentChips), 4, 5 |
| Durable save before/independent of choice; offline capture | 4, 5 (progressive enhancement) |
| Move a reel between collections; syncs | 7 (move), 1 (drainAll), 2 (picker) |
| Delete never silently drops reels (Saved / dismiss / cancel) | 3 (planner), 6 (flow) |
| `collection_id` + list sync to D1; reminder cols untouched | 1 (drainAll), 05a rails |
| `topic_tags` preserved; no mandatory tagging prompt | 6 (home replaces launcher; tag.html unlinked as a required step) |
| Deferred: cleanup view (C), backlog picker (D) | — (→ 05c) |
