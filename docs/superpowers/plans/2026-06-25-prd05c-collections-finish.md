# PRD 05c — Collections finish (cleanup view + backlog picker) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish PRD 05 — add an optional cleanup view that moves "Saved" reels into collections via one-tap chips, and let backlog promotion target a collection — reusing every existing 05a/05b piece.

**Architecture:** One new pure-ish change (`promote` gains an optional `collectionId`, unit-tested). Two DOM views: `cleanup.html`/`cleanup-view.ts` (renamed from `tag.html`/`tag-view.ts`, rewritten to list "Saved" and move via `recentChips`/`pickerSheet`) and an extended `triage-view.ts` ("Keep to…"/"Keep all to…"). DOM views are verified by `tsc` + `vite build` + manual checks (node test env has no DOM).

**Tech Stack:** TypeScript, IndexedDB via `idb`, Vite, Vitest (node env, fake-indexeddb). No new dependencies.

## Global Constraints

- **No new runtime dependencies.**
- **`collection_id` null/undefined ≡ "Saved".** The cleanup view lists `listByCollection(saved.id, saved.id)` (includes null-collection items). A promoted reel with no collection choice writes no `collection_id`.
- **Least-tap promote preserved.** The existing one-tap "Keep" (→ Saved) and "Keep all" (→ Saved) stay behaviourally unchanged; the collection picker is strictly additive.
- **Views exclude `status === "dismissed"`** in the view layer. Do NOT change 05a/05b store methods (`pending-store`, `collections-store`).
- **Device-owned content only.** `move`/`dismiss`/`promote` set `synced=false` and ride `/api/sync`; reminder columns are never touched.
- **Reuse, don't reinvent:** `renderReelCard` (`src/reel-card.ts`), `recentChips`/`pickerSheet` (`src/collection-picker.ts`), `drainAll` (`src/drain-all.ts`), `createCollectionsStore`, `createPendingStore` already exist and are committed.
- **Test env is `node`** (`vitest.config.ts`): unit tests are headless only. DOM modules are verified with `npx tsc --noEmit` + `npx vite build` + `docs/manual-verification.md`.
- **Run `npx tsc --noEmit && npx vitest run` at each task's verify step.** Baseline at branch HEAD: 149 tests green.
- Commit message trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: `promote` gains an optional `collectionId`

**Files:**
- Modify: `src/import/promote.ts`
- Modify: `tests/import/promote.test.ts`

**Interfaces:**
- Consumes: existing `promote(item, deps)` and `PromoteDeps`.
- Produces: `promote(item: ImportedItem, deps: PromoteDeps, collectionId?: string): Promise<void>` — when `collectionId` is given, the written `PendingCapture` carries `collection_id === collectionId`; when omitted, `collection_id` is absent (null-is-Saved).

- [ ] **Step 1: Write the failing tests** — append inside the `describe("promote", …)` in `tests/import/promote.test.ts`

```ts
  it("sets collection_id when a collectionId is given", async () => {
    const d = deps();
    await promote(item(), d.obj, "col-recipes");
    expect(d.put.mock.calls[0][0].collection_id).toBe("col-recipes");
  });

  it("leaves collection_id undefined when no collectionId is given (null-is-Saved)", async () => {
    const d = deps();
    await promote(item(), d.obj);
    expect(d.put.mock.calls[0][0].collection_id).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/import/promote.test.ts`
Expected: FAIL — `collection_id` is `undefined` for the first new case (promote ignores the 3rd arg).

- [ ] **Step 3: Add the `collectionId` parameter** — edit `src/import/promote.ts`

Change the signature and add one spread to the record. Full new file:

```ts
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

export async function promote(
  item: ImportedItem,
  deps: PromoteDeps,
  collectionId?: string,
): Promise<void> {
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
    author: item.author,
    media_type: item.media_type,
    ...(enrichment ?? {}),
    ...(item.caption ? { description: item.caption } : {}),
    ...(collectionId ? { collection_id: collectionId } : {}),
  };

  await deps.pendingStore.put(record);
  deps.drain();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/import/promote.test.ts`
Expected: PASS (the 4 existing + 2 new = 6 cases).

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all green (149 + 2 = 151).

- [ ] **Step 6: Commit**

```bash
git add src/import/promote.ts tests/import/promote.test.ts
git commit -m "feat(prd05c): promote accepts an optional collectionId (null-is-Saved default)"
```

---

### Task 2: Cleanup view — rename `tag.html`→`cleanup.html`, `tag-view.ts`→`cleanup-view.ts`, rewrite

**Files:**
- Rename + rewrite: `tag.html` → `cleanup.html`
- Rename + rewrite: `src/tag-view.ts` → `src/cleanup-view.ts`
- Modify: `src/sw.ts` (SHELL entry + CACHE bump)
- Modify: `vite.config.ts` (input entry)
- Modify: `index.html` (add "Tidy Saved" nav link)

**Interfaces:**
- Consumes: `createPendingStore` (`listByCollection`/`move`/`dismiss`/`restore`), `createCollectionsStore` (`list`), `drainAll`, `renderReelCard`, `recentChips`, `pickerSheet`.
- Produces: the cleanup page; no exports consumed by other tasks.

No unit test (DOM + node test env). Verified by `tsc` + `vite build` (must emit `dist/cleanup.html`, and NOT `dist/tag.html`) + manual verification (Task 4).

- [ ] **Step 1: Rename the files (preserve history)**

```bash
git mv tag.html cleanup.html
git mv src/tag-view.ts src/cleanup-view.ts
```

- [ ] **Step 2: Replace `cleanup.html`** with:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#111111" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <title>InSave — Tidy your Saved pile</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #111; color: #eee; }
      header { padding: 20px; }
      h1 { font-size: 1.3rem; margin: 0 0 8px; }
      p { color: #aaa; margin: 4px 0; line-height: 1.5; }
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
      .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; align-items: center; }
      .chip { background: #1e2a3a; color: #cfe0ff; border: 1px solid #2c3e57; border-radius: 14px; padding: 4px 12px; font-size: 14px; }
      .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 6px; }
      button { background: #2a2a2a; color: #eee; border: 1px solid #3a3a3a; border-radius: 6px; padding: 6px 12px; font-size: 14px; }
      .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: flex-end; justify-content: center; }
      .picker-sheet { background: #1b1b1b; border: 1px solid #333; border-radius: 12px 12px 0 0;
                      width: 100%; max-width: 28rem; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
      .picker-option { background: #2a2a2a; color: #eee; border: 1px solid #3a3a3a; border-radius: 6px; padding: 10px 12px; font-size: 15px; text-align: left; }
      .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
               background: #222; border: 1px solid #3a3a3a; border-radius: 8px; padding: 10px 16px;
               display: none; align-items: center; gap: 12px; }
      .toast.show { display: flex; }
    </style>
  </head>
  <body>
    <header>
      <h1>Tidy your Saved pile</h1>
      <p>Move unsorted reels into collections — tap a collection chip, or “More…” for the full list.
         Totally optional; do it whenever you feel like it.</p>
      <p><a href="/">← Collections</a></p>
    </header>
    <div id="empty" class="empty">Saved is tidy — nothing to sort.</div>
    <div id="list"></div>
    <div id="toast" class="toast" role="status"></div>
    <script type="module" src="/src/cleanup-view.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Replace `src/cleanup-view.ts`** with:

```ts
import { createPendingStore } from "./pending-store";
import { createCollectionsStore } from "./collections-store";
import { drainAll } from "./drain-all";
import { renderReelCard } from "./reel-card";
import { recentChips, pickerSheet } from "./collection-picker";
import type { PendingCapture } from "./types";

const listEl = document.getElementById("list")!;
const emptyEl = document.getElementById("empty")!;
const toastEl = document.getElementById("toast")!;

let toastTimer: ReturnType<typeof setTimeout> | undefined;

function showUndoToast(message: string, onUndo: () => void): void {
  toastEl.textContent = message + " ";
  const btn = document.createElement("button");
  btn.textContent = "Undo";
  btn.addEventListener("click", () => { onUndo(); hideToast(); });
  toastEl.appendChild(btn);
  toastEl.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}

function hideToast(): void {
  toastEl.classList.remove("show");
  toastEl.textContent = "";
}

async function main(): Promise<void> {
  const collectionsStore = await createCollectionsStore();
  const pendingStore = await createPendingStore();
  const collections = await collectionsStore.list();
  const saved = collections.find((c) => c.is_default)!;
  const drain = () => { drainAll(pendingStore, collectionsStore).catch(() => {}); };
  drain();

  const items = (await pendingStore.listByCollection(saved.id, saved.id))
    .filter((r) => r.status !== "dismissed");

  if (items.length === 0) {
    emptyEl.classList.add("show");
    return;
  }
  for (const item of items) listEl.appendChild(renderCard(item));

  function renderCard(item: PendingCapture): HTMLElement {
    const card = renderReelCard(item);

    const chipsRow = document.createElement("div");
    chipsRow.className = "chips";
    for (const c of recentChips(collections)) {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.textContent = c.name;
      chip.addEventListener("click", () => { void moveTo(item, c.id, card); });
      chipsRow.appendChild(chip);
    }
    // "More…": full picker for collections beyond the chip cap (Saved excluded —
    // the item is already in Saved).
    const moreBtn = document.createElement("button");
    moreBtn.textContent = "More…";
    moreBtn.addEventListener("click", () => openPicker(item, card));
    chipsRow.appendChild(moreBtn);
    card.appendChild(chipsRow);

    const controls = document.createElement("div");
    controls.className = "controls";
    const dismissBtn = document.createElement("button");
    dismissBtn.textContent = "Dismiss";
    dismissBtn.addEventListener("click", async () => {
      await pendingStore.dismiss(item.id);
      drain();
      card.remove();
      if (listEl.children.length === 0) emptyEl.classList.add("show");
      showUndoToast("Dismissed.", () => {
        void pendingStore.restore(item.id).then(() => {
          drain();
          emptyEl.classList.remove("show");
          listEl.appendChild(renderCard(item));
        });
      });
    });
    controls.appendChild(dismissBtn);
    card.appendChild(controls);

    return card;
  }

  async function moveTo(item: PendingCapture, collectionId: string, card: HTMLElement): Promise<void> {
    await pendingStore.move(item.id, collectionId);
    drain();
    card.remove();
    if (listEl.children.length === 0) emptyEl.classList.add("show");
    const name = collections.find((c) => c.id === collectionId)?.name ?? "collection";
    showUndoToast(`Moved to ${name}.`, () => {
      // Re-home to Saved (null-is-Saved makes the explicit Saved id equivalent).
      void pendingStore.move(item.id, saved.id).then(() => {
        drain();
        emptyEl.classList.remove("show");
        listEl.appendChild(renderCard(item));
      });
    });
  }

  function openPicker(item: PendingCapture, card: HTMLElement): void {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const sheet = pickerSheet(collections, {
      exclude: saved.id,
      onPick: (target) => { overlay.remove(); void moveTo(item, target, card); },
    });
    overlay.appendChild(sheet);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }
}

void main();
```

- [ ] **Step 4: Update the SW shell** — edit `src/sw.ts`

Swap the SHELL entry and bump the cache:

```ts
const SHELL = ["/", "/index.html", "/captured.html", "/collection.html", "/cleanup.html", "/review.html", "/manifest.webmanifest"];
// Bump on any SW behavior change so activate() purges the previous cache.
const CACHE = "insave-shell-v4";
```

- [ ] **Step 5: Update the Vite input map** — edit `vite.config.ts`

Rename the `tag` entry to `cleanup`:

```ts
        cleanup: resolve(__dirname, "cleanup.html"),
```

(Replace the existing `tag: resolve(__dirname, "tag.html"),` line.)

- [ ] **Step 6: Add the "Tidy Saved" link to the home** — edit `index.html`

In the header `<nav>`, add a link after the Review link (before the `enable-reminders` button):

```html
        <a href="/cleanup.html">Tidy Saved</a>
```

- [ ] **Step 7: Typecheck + build**

Run: `npx tsc --noEmit && npx vite build`
Expected: tsc clean; build emits `dist/cleanup.html` and there is **no** `dist/tag.html`. Confirm: `ls dist/cleanup.html` exists; `ls dist/tag.html` does not.

- [ ] **Step 8: Run the full suite** (rename must not break any import)

Run: `npx vitest run`
Expected: all green (151) — no test imported `tag-view` (it was DOM-only and untested).

- [ ] **Step 9: Commit**

```bash
# git mv (Step 1) already staged the renames (old paths deleted, new paths added).
# Stage the rewritten content + the wiring edits, then commit everything together.
git add -A
git commit -m "feat(prd05c): cleanup view over Saved (chip-move), retires the tag queue"
```

> `git add -A` picks up the rewritten `cleanup.html`/`cleanup-view.ts` content on top of the staged renames plus the `sw.ts`/`vite.config.ts`/`index.html` edits. Verify with `git status` that `tag.html`/`src/tag-view.ts` show as renamed (R), not as separate add+delete, before committing.

---

### Task 3: Backlog-promote collection picker — `triage-view.ts` + `import.html` styles

**Files:**
- Modify: `src/import/triage-view.ts`
- Modify: `import.html` (add overlay/picker styles)

**Interfaces:**
- Consumes: `promote` with the new `collectionId` (Task 1), `createCollectionsStore`, `drainAll`, `pickerSheet`.
- Produces: the extended triage UI; no exports consumed by other tasks.

No unit test (DOM + node test env). Verified by `tsc` + `vite build` + manual verification (Task 4).

- [ ] **Step 1: Replace `src/import/triage-view.ts`** with:

```ts
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
import { createCollectionsStore } from "../collections-store";
import { drainAll } from "../drain-all";
import { pickerSheet } from "../collection-picker";
import type { Collection, ImportedItem } from "../types";

const fileInput = document.getElementById("file") as HTMLInputElement;
const banner = document.getElementById("banner")!;
const summary = document.getElementById("summary")!;
const list = document.getElementById("list")!;

// Loaded once per import so the "Keep to…" pickers have collections to offer.
let collections: Collection[] = [];

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
    const collectionsStore = await createCollectionsStore();
    collections = await collectionsStore.list();
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
  const keepAllTo = document.createElement("button");
  keepAllTo.textContent = "Keep all to…";
  const dismissAll = document.createElement("button");
  dismissAll.textContent = "Dismiss all";
  bulk.appendChild(keepAll);
  bulk.appendChild(keepAllTo);
  bulk.appendChild(dismissAll);
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
  keepAllTo.addEventListener("click", () => {
    openPicker((collectionId) => {
      void (async () => {
        for (const item of group.items) await keep(item, collectionId);
        section.remove();
      })();
    });
  });
  dismissAll.addEventListener("click", () => {
    section.remove(); // dismissed items stay dormant in the store, just hidden
  });

  return section;
}

function renderItem(item: ImportedItem): HTMLElement {
  const li = document.createElement("li");

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = item.media_type;

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

  const keepToBtn = document.createElement("button");
  keepToBtn.textContent = "Keep to…";
  keepToBtn.addEventListener("click", () => {
    openPicker((collectionId) => {
      void keep(item, collectionId).then(() => {
        li.classList.add("kept");
        keepBtn.disabled = true;
        keepToBtn.disabled = true;
      });
    });
  });

  const skipBtn = document.createElement("button");
  skipBtn.textContent = "Skip";
  skipBtn.addEventListener("click", () => li.remove());

  li.appendChild(keepBtn);
  li.appendChild(keepToBtn);
  li.appendChild(skipBtn);
  li.appendChild(badge);
  li.appendChild(link);

  if (item.caption) {
    const caption = document.createElement("p");
    caption.className = "caption";
    caption.textContent = item.caption;
    li.appendChild(caption);
  }

  return li;
}

function openPicker(onPick: (collectionId: string) => void): void {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const sheet = pickerSheet(collections, {
    onPick: (id) => { overlay.remove(); onPick(id); },
  });
  overlay.appendChild(sheet);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

async function keep(item: ImportedItem, collectionId?: string): Promise<void> {
  const importedStore = await createImportedStore();
  // Idempotent: skip if already promoted (e.g. "Keep all" over an item the user
  // already kept individually) so we don't write duplicate pending_capture rows.
  if (item.canonical_url) {
    const stored = await importedStore.getByCanonicalUrl(item.canonical_url);
    if (stored?.backlog_state === "promoted") return;
  }
  const pendingStore = await createPendingStore();
  const collectionsStore = await createCollectionsStore();
  await promoteItem(
    item,
    {
      importedStore,
      pendingStore,
      enricher: stubEnricher,
      drain: () => { drainAll(pendingStore, collectionsStore).catch(() => {}); },
      uuid: () => crypto.randomUUID(),
    },
    collectionId,
  );
}
```

- [ ] **Step 2: Add overlay/picker styles to `import.html`**

Insert these rules immediately before the closing `</style>` in `import.html` (the `.bulk`, `.kept`, and generic `button` styles already exist):

```css
      .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: flex-end; justify-content: center; }
      .picker-sheet { background: #1b1b1b; border: 1px solid #333; border-radius: 12px 12px 0 0;
                      width: 100%; max-width: 28rem; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
      .picker-option { background: #2a2a2a; color: #eee; border: 1px solid #3a3a3a; border-radius: 6px; padding: 10px 12px; font-size: 15px; text-align: left; }
      .badge { font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
               background: #2a2a2a; border: 1px solid #3a3a3a; border-radius: 4px; padding: 1px 6px; color: #bbb; }
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npx vite build`
Expected: tsc clean; build succeeds (the `importPage` entry bundles the updated `triage-view`).

- [ ] **Step 4: Full suite** (import/promote suites must stay green)

Run: `npx vitest run`
Expected: all green (151).

- [ ] **Step 5: Commit**

```bash
git add src/import/triage-view.ts import.html
git commit -m "feat(prd05c): backlog promote can target a collection (Keep to…/Keep all to…)"
```

---

### Task 4: Manual-verification docs + final verification

**Files:**
- Modify: `docs/manual-verification.md`

No code; documents the DOM behaviour the headless suite can't cover and runs the final gate.

- [ ] **Step 1: Append the PRD 05c section to `docs/manual-verification.md`** (after the last section)

```markdown
## PRD 05c — Collections finish (cleanup view + backlog picker)

No schema change (05a covered it). Reinstall/refresh once so the SW serves the new shell (cache v4).

### Checklist
- [ ] Home shows a "Tidy Saved" link → opens the cleanup view listing unsorted "Saved" reels (including ones captured with no collection).
- [ ] Tap a collection chip on a cleanup card → the reel moves into that collection (gone from cleanup, present in that collection); Undo returns it to Saved.
- [ ] "More…" lists collections beyond the chip cap and moves correctly; "Saved" is not offered as a target.
- [ ] Dismiss on a cleanup card removes it (status=dismissed in D1) with Undo.
- [ ] Old `/tag.html` no longer resolves; `/cleanup.html` loads (SW cache bumped to v4).
- [ ] Import triage: "Keep" still promotes to "Saved" in one tap; "Keep to…" / "Keep all to…" promote into the chosen collection — verify `collection_id` in D1 after sync; reminder columns untouched.
- [ ] Promoting a backlog item with no collection choice lands it in "Saved" (no `collection_id`).
```

- [ ] **Step 2: Final verification**

Run: `npx tsc --noEmit && npx vitest run && npx vite build`
Expected: tsc clean; all green (151 — 149 baseline + 2 new promote cases); build emits `dist/cleanup.html`, `dist/index.html`, `dist/collection.html`, `dist/captured.html`, `dist/import.html`, and `dist/review.html`, with no `dist/tag.html`.

> Test-count note: the exact total is whatever `vitest run` reports; the point is **zero failures** and the two new `promote` cases present. Do not hand-tune the number.

- [ ] **Step 3: Commit**

```bash
git add docs/manual-verification.md
git commit -m "docs(prd05c): manual-verification checklist; finishes PRD 05"
```

---

## Final verification (after all tasks)

- [ ] `npx tsc --noEmit` — clean.
- [ ] `npx vitest run` — all green (149 baseline + 2 new `promote` cases).
- [ ] `npx vite build` — succeeds; `dist/` includes `cleanup.html` (not `tag.html`) plus the other pages.
- [ ] Spec acceptance (§7) re-read against the diff; all PRD 05 §10 items now satisfied (05a+05b+05c).
- [ ] Least-tap promote preserved: "Keep"/"Keep all" still go to "Saved" with the same single tap.

## Spec coverage map

| Spec §7 acceptance | Task |
|---|---|
| Optional cleanup view over "Saved" with one-tap chip move | 2 |
| Backlog promotion can target a collection via the picker; default Saved | 1, 3 |
| No-choice promote still lands in "Saved" with one tap | 1 (optional param), 3 (Keep unchanged) |
| Cleanup moves/dismisses sync as device-owned; reminder cols untouched | 2 (move/dismiss), 1 |
| `topic_tags` preserved; no mandatory tagging prompt anywhere | 2 (tag queue retired) |
