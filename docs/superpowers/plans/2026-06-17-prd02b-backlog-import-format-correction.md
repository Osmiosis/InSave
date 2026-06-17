# PRD 02b — Backlog Import Format Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the Instagram backlog parser to read the *real* `saved_posts.json` (a bare top-level array with per-entry `label_values`), carry the now-available caption + owner username + media type through the import pipeline, and refresh all affected tests.

**Architecture:** Pure functions stay pure and node-testable. `parse-saved-posts.ts` is rewritten to resolve the entry list (array, or a wrapper object for forward-compat) then extract URL/Caption/Owner-Username/timestamp/media-type per entry. New fields flow `ParsedSavedItem → ImportedItem → pending_capture.description` (at promote). `triage-view.ts` (DOM glue, no unit tests — node test env) gains caption + reel/post badge, verified by `tsc`/build/manual. No D1/Worker/schema change — `author`/`media_type` propagation to the tracked set is deferred to PRD 03.

**Tech Stack:** TypeScript, Vite, vitest (node env), fflate (zip), fake-indexeddb (store tests).

**Spec:** `docs/superpowers/specs/2026-06-17-prd02b-backlog-import-format-correction-design.md`

---

## File Structure

- **Modify** `src/types.ts` — add `caption?`/`mediaType` to `ParsedSavedItem`; `caption?`/`media_type` to `ImportedItem`.
- **Rewrite** `src/import/parse-saved-posts.ts` — real array/`label_values` extraction.
- **Modify** `src/import/normalize-import.ts` — carry `caption`/`media_type` onto `ImportedItem`.
- **Modify** `src/import/promote.ts` — set `description` from caption (export wins over enricher).
- **Modify** `src/import/triage-view.ts` — render caption + reel/post badge.
- **Modify tests** — `parse-saved-posts.test.ts` (rewrite), `zip.test.ts` (fixture body), `normalize-import.test.ts` (+fields), `promote.test.ts` (+description), and fixture-only repairs in `imported-store.test.ts`, `triage.test.ts`, `reconcile.test.ts`.
- **Append** `docs/manual-verification.md` — triage caption/badge check.
- **Append** `notes.md` — PRD 02b chronological summary.

Commands (run from `C:\InSave`):
- Single test file: `npx vitest run tests/import/<file>.test.ts`
- Typecheck: `npx tsc --noEmit`
- Full suite: `npx vitest run`
- Build: `npm run build`

---

## Task 1: Extend types + repair existing fixtures (prep)

Introduce the new fields and keep `tsc` green before any behaviour changes. `media_type` is **required** on `ImportedItem`, so the four fixtures that build `ImportedItem` literals must add it now; `mediaType` is required on `ParsedSavedItem`, so the normalize fixture must add it.

**Files:**
- Modify: `src/types.ts`
- Modify: `tests/import/imported-store.test.ts`, `tests/import/triage.test.ts`, `tests/import/reconcile.test.ts`, `tests/import/promote.test.ts`, `tests/import/normalize-import.test.ts`

- [ ] **Step 1: Add fields to `ParsedSavedItem` and `ImportedItem`**

In `src/types.ts`, change `ParsedSavedItem`:

```typescript
export interface ParsedSavedItem {
  url: string;
  author: string;
  savedAt: number; // epoch ms (converted from the export's seconds)
  caption?: string;
  mediaType: "reel" | "post";
}
```

And `ImportedItem` (add the two fields; keep the rest unchanged):

```typescript
export interface ImportedItem {
  id: string;
  canonical_url: string;
  author: string;
  saved_at: number;    // original Instagram save timestamp, epoch ms
  imported_at: number; // when InSave ingested it, epoch ms
  raw_payload: string; // JSON of the raw export entry
  parse_ok: boolean;
  backlog_state: BacklogState;
  caption?: string;
  media_type: "reel" | "post";
}
```

- [ ] **Step 2: Repair the four `ImportedItem` fixtures (add `media_type`)**

`tests/import/imported-store.test.ts` — in `item()` add `media_type` to the returned object:

```typescript
    parse_ok: true,
    backlog_state: over.backlog_state ?? "dormant",
    media_type: over.media_type ?? "reel",
    ...over,
```

`tests/import/triage.test.ts` — in `item()`:

```typescript
    raw_payload: "{}", parse_ok: true, backlog_state: "dormant", media_type: "reel",
```

`tests/import/reconcile.test.ts` — in `item()`:

```typescript
    raw_payload: "{}", parse_ok, backlog_state: "dormant", media_type: "reel",
```

`tests/import/promote.test.ts` — in `item()`:

```typescript
    saved_at: 1000, imported_at: 2000, raw_payload: '{"x":1}', parse_ok: true,
    backlog_state: "dormant", media_type: "reel",
```

- [ ] **Step 3: Repair the `ParsedSavedItem` fixture (add `mediaType`)**

`tests/import/normalize-import.test.ts` — update `parsed()` so it satisfies the required field and allows overrides:

```typescript
function parsed(
  url: string,
  author = "a",
  savedAt = 1,
  over: Partial<ParsedSavedItem> = {},
): ParsedSavedItem {
  return { url, author, savedAt, mediaType: "reel", ...over };
}
```

- [ ] **Step 4: Typecheck + full suite stay green**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx vitest run`
Expected: all existing tests PASS (no behaviour changed yet).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/import/imported-store.test.ts tests/import/triage.test.ts tests/import/reconcile.test.ts tests/import/promote.test.ts tests/import/normalize-import.test.ts
git commit -m "refactor: add caption/media_type fields to import types"
```

---

## Task 2: Rewrite the parser for the real array format

**Files:**
- Modify: `src/import/parse-saved-posts.ts` (full rewrite)
- Test: `tests/import/parse-saved-posts.test.ts` (full rewrite)

- [ ] **Step 1: Replace the parser test with real-format fixtures**

Overwrite `tests/import/parse-saved-posts.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseSavedPosts } from "../../src/import/parse-saved-posts";
import { ImportError } from "../../src/import/errors";

const reelEntry = {
  timestamp: 1734200000, // Dec 2024, seconds
  media: [],
  label_values: [
    { label: "URL", value: "https://www.instagram.com/reel/DZZSfMqu6WY/", href: "https://www.instagram.com/reel/DZZSfMqu6WY/" },
    { label: "Caption", value: "Problems nobody solved yet, part 3" },
    { label: "Title", value: "" },
    { dict: [], title: "Hashtags" },
    { title: "Owner", dict: [ { title: "", dict: [
      { label: "URL", value: "https://gotaprob.beehiiv.com" },
      { label: "Name", value: "Idea Guy" },
      { label: "Username", value: "iamideaguy" },
    ] } ] },
  ],
  fbid: "18056521565574781",
};

const postNoCaption = {
  timestamp: 1734300000,
  label_values: [
    { label: "URL", value: "https://www.instagram.com/p/CymPostId/" },
    { title: "Owner", dict: [ { title: "", dict: [
      { label: "Username", value: "postcreator" },
    ] } ] },
  ],
};

const reelNoOwner = {
  timestamp: 1734400000,
  label_values: [
    { label: "URL", value: "https://www.instagram.com/reel/NoOwner1/" },
    { label: "Caption", value: "anon clip" },
  ],
};

describe("parseSavedPosts", () => {
  it("parses a real top-level array: url, username, caption, media type, seconds->ms", () => {
    const items = parseSavedPosts(JSON.stringify([reelEntry, postNoCaption, reelNoOwner]));
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      url: "https://www.instagram.com/reel/DZZSfMqu6WY/",
      author: "iamideaguy",
      savedAt: 1734200000000,
      caption: "Problems nobody solved yet, part 3",
      mediaType: "reel",
    });
  });

  it("handles posts (/p/) and a missing caption", () => {
    const items = parseSavedPosts(JSON.stringify([postNoCaption]));
    expect(items[0].mediaType).toBe("post");
    expect(items[0].author).toBe("postcreator");
    expect(items[0].caption).toBeUndefined();
  });

  it("tolerates a missing Owner (author empty, not fatal)", () => {
    const items = parseSavedPosts(JSON.stringify([reelNoOwner]));
    expect(items[0].author).toBe("");
    expect(items[0].caption).toBe("anon clip");
  });

  it("tolerates a legacy wrapper object around the array", () => {
    const items = parseSavedPosts(JSON.stringify({ saved_saved_media: [reelEntry] }));
    expect(items).toHaveLength(1);
    expect(items[0].author).toBe("iamideaguy");
  });

  it("throws ImportError on invalid JSON", () => {
    expect(() => parseSavedPosts("{not json")).toThrow(ImportError);
  });

  it("throws ImportError when the shape is neither array nor known wrapper", () => {
    expect(() => parseSavedPosts(JSON.stringify({ something_else: [] }))).toThrow(ImportError);
  });

  it("throws ImportError when there are zero entries", () => {
    expect(() => parseSavedPosts(JSON.stringify([]))).toThrow(ImportError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/import/parse-saved-posts.test.ts`
Expected: FAIL — the old parser looks for `saved_saved_media`/`string_map_data`, so it throws/returns wrong shapes (e.g. `author` is `""`, `mediaType` undefined, wrapper-only success).

- [ ] **Step 3: Rewrite the parser**

Overwrite `src/import/parse-saved-posts.ts`:

```typescript
import type { ParsedSavedItem } from "../types";
import { ImportError } from "./errors";

interface LabelValue {
  label?: unknown;
  value?: unknown;
  href?: unknown;
  title?: unknown;
  dict?: unknown;
}

function labelValues(entry: unknown): LabelValue[] {
  if (!entry || typeof entry !== "object") return [];
  const lv = (entry as { label_values?: unknown }).label_values;
  return Array.isArray(lv) ? (lv as LabelValue[]) : [];
}

function byLabel(items: LabelValue[], label: string): LabelValue | undefined {
  return items.find((i) => i && typeof i === "object" && i.label === label);
}

function byTitle(items: LabelValue[], title: string): LabelValue | undefined {
  return items.find((i) => i && typeof i === "object" && i.title === title);
}

function ownerUsername(items: LabelValue[]): string {
  const owner = byTitle(items, "Owner");
  const outer = owner && Array.isArray(owner.dict) ? (owner.dict as unknown[]) : [];
  const first = outer[0];
  const inner =
    first && typeof first === "object" && Array.isArray((first as { dict?: unknown }).dict)
      ? ((first as { dict: unknown[] }).dict as LabelValue[])
      : [];
  const username = byLabel(inner, "Username");
  return typeof username?.value === "string" ? username.value : "";
}

function mediaTypeFromUrl(url: string): "reel" | "post" {
  return url.includes("/reel/") ? "reel" : "post";
}

function resolveEntryList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const wrapped = (data as { saved_saved_media?: unknown })?.saved_saved_media;
  if (Array.isArray(wrapped)) return wrapped;
  throw new ImportError();
}

export function parseSavedPosts(jsonText: string): ParsedSavedItem[] {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new ImportError();
  }

  const list = resolveEntryList(data);

  const items: ParsedSavedItem[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const lv = labelValues(entry);

    const urlItem = byLabel(lv, "URL");
    const url =
      typeof urlItem?.value === "string"
        ? urlItem.value
        : typeof urlItem?.href === "string"
          ? urlItem.href
          : "";

    const captionItem = byLabel(lv, "Caption");
    const caption =
      typeof captionItem?.value === "string" && captionItem.value
        ? captionItem.value
        : undefined;

    const tsRaw = (entry as { timestamp?: unknown }).timestamp;
    const tsSeconds = typeof tsRaw === "number" ? tsRaw : 0;

    items.push({
      url,
      author: ownerUsername(lv),
      savedAt: tsSeconds > 0 ? tsSeconds * 1000 : 0,
      caption,
      mediaType: mediaTypeFromUrl(url),
    });
  }

  if (items.length === 0) throw new ImportError();
  return items;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/import/parse-saved-posts.test.ts`
Expected: PASS (all 7).

- [ ] **Step 5: Commit**

```bash
git add src/import/parse-saved-posts.ts tests/import/parse-saved-posts.test.ts
git commit -m "fix: parse real saved_posts.json array format (PRD 02b)"
```

---

## Task 3: Carry caption + media_type through normalize

**Files:**
- Modify: `src/import/normalize-import.ts:27-36`
- Test: `tests/import/normalize-import.test.ts`

- [ ] **Step 1: Add the failing test**

Append inside the `describe("toImportedItems", ...)` block in `tests/import/normalize-import.test.ts`:

```typescript
  it("carries caption and media_type onto the imported item", () => {
    n = 0;
    const out = toImportedItems(
      [parsed("https://www.instagram.com/p/AAA/", "a", 1, { caption: "hi", mediaType: "post" })],
      deps,
    );
    expect(out[0].caption).toBe("hi");
    expect(out[0].media_type).toBe("post");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/import/normalize-import.test.ts`
Expected: FAIL — `out[0].caption` and `out[0].media_type` are `undefined`.

- [ ] **Step 3: Carry the fields in `toImportedItems`**

In `src/import/normalize-import.ts`, add the two fields to the pushed object:

```typescript
    out.push({
      id: deps.uuid(),
      canonical_url: canonicalUrl,
      author: p.author,
      saved_at: p.savedAt,
      imported_at: importedAt,
      raw_payload: JSON.stringify(p),
      parse_ok: parseOk,
      backlog_state: "dormant",
      caption: p.caption,
      media_type: p.mediaType,
    });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/import/normalize-import.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/import/normalize-import.ts tests/import/normalize-import.test.ts
git commit -m "feat: carry caption and media_type into imported items (PRD 02b)"
```

---

## Task 4: Fill `description` from the export caption at promote

**Files:**
- Modify: `src/import/promote.ts:19-30`
- Test: `tests/import/promote.test.ts`

- [ ] **Step 1: Add the failing tests**

Append two tests inside `describe("promote", ...)` in `tests/import/promote.test.ts`:

```typescript
  it("fills description from the imported caption", async () => {
    const d = deps();
    await promote({ ...item(), caption: "the caption" }, d.obj);
    expect(d.put.mock.calls[0][0].description).toBe("the caption");
  });

  it("export caption wins over an enricher-provided description", async () => {
    const d = deps();
    d.enrich.mockResolvedValueOnce({ description: "from enricher" } as never);
    await promote({ ...item(), caption: "from export" }, d.obj);
    expect(d.put.mock.calls[0][0].description).toBe("from export");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/import/promote.test.ts`
Expected: FAIL — `description` is `undefined` (first test) and `"from enricher"` (second), because promote never reads `item.caption`.

- [ ] **Step 3: Set `description` from caption (export wins)**

In `src/import/promote.ts`, build the record so the export caption overrides any enricher description:

```typescript
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
    ...(item.caption ? { description: item.caption } : {}),
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/import/promote.test.ts`
Expected: PASS (existing promote tests included).

- [ ] **Step 5: Commit**

```bash
git add src/import/promote.ts tests/import/promote.test.ts
git commit -m "feat: fill pending_capture.description from export caption (PRD 02b)"
```

---

## Task 5: Update the zip fixture to the array shape

The zip path-extraction logic is already correct; only the in-test fixture body uses the old wrapper. Update it so the fixture reflects reality.

**Files:**
- Test: `tests/import/zip.test.ts`

- [ ] **Step 1: Update the fixture and assertions**

In `tests/import/zip.test.ts`, replace the fixture constant and the two `toHaveProperty` assertions:

```typescript
const JSON_TEXT = JSON.stringify([
  { timestamp: 1, label_values: [{ label: "URL", value: "https://www.instagram.com/reel/Z/" }] },
]);
```

In the "plain JSON blob" test:

```typescript
    expect(Array.isArray(JSON.parse(text))).toBe(true);
```

In the "nested saved_posts.json from a zip" test:

```typescript
    expect(Array.isArray(JSON.parse(text))).toBe(true);
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run tests/import/zip.test.ts`
Expected: PASS (path-finding unchanged; fixture now array-shaped).

- [ ] **Step 3: Commit**

```bash
git add tests/import/zip.test.ts
git commit -m "test: use real array shape in zip fixture (PRD 02b)"
```

---

## Task 6: Show caption + reel/post badge on triage cards

`triage-view.ts` accesses `document` at module top-level and the test env is node, so it has no unit test (consistent with today). Verified by `tsc`, build, and a manual-verification entry.

**Files:**
- Modify: `src/import/triage-view.ts` (the `renderItem` function, lines ~100-125)
- Modify: `docs/manual-verification.md`

- [ ] **Step 1: Render the badge and caption in `renderItem`**

In `src/import/triage-view.ts`, update `renderItem` to add a reel/post badge and the caption text. Replace the function body's element-building with:

```typescript
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

  const skipBtn = document.createElement("button");
  skipBtn.textContent = "Skip";
  skipBtn.addEventListener("click", () => li.remove());

  li.appendChild(keepBtn);
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
```

- [ ] **Step 2: Typecheck and build**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run build`
Expected: clean build (emits `import.html` + bundle, as today).

- [ ] **Step 3: Add a manual-verification entry**

Append to `docs/manual-verification.md`:

```markdown

## PRD 02b — Backlog import format correction

- [ ] Upload a real Instagram export `.zip`; the importer reads it (no "couldn't read" error).
- [ ] Triage cards show the caption text and a `reel`/`post` badge per item.
- [ ] An item with no caption renders without an empty caption line.
- [ ] Promote an item; in D1 / pending sync its `description` equals the export caption.
- [ ] Both reels (`/reel/`) and posts (`/p/`) appear in triage.
```

- [ ] **Step 4: Commit**

```bash
git add src/import/triage-view.ts docs/manual-verification.md
git commit -m "feat: show caption and reel/post badge on triage cards (PRD 02b)"
```

---

## Task 7: Full verification + notes

**Files:**
- Modify: `notes.md`

- [ ] **Step 1: Run the full suite + typecheck + build**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: tsc clean; all test files green (the 46 prior tests, adjusted, plus the new parser/normalize/promote cases); clean production build.

- [ ] **Step 2: Append the PRD 02b summary to `notes.md`**

Add a new section at the end of `notes.md` (follow the existing PRD 01/02 entry style): what it is (parser correction for the real array format), decisions (import both reels+posts, caption→description, media_type/author deferred to PRD 03), how it works (resolveEntryList + label_values extraction; caption fills description at promote; triage badge), delivered/verified (tsc + full suite + build), and still-open (live-capture enrichment still deferred; PRD 03 adds author/media_type columns).

- [ ] **Step 3: Commit**

```bash
git add notes.md
git commit -m "docs: PRD 02b notes summary"
```

---

## Self-Review

**Spec coverage:**
- Parser reads top-level array + extracts URL/Caption/Username → Task 2.
- `description` populated from Caption (no network) → Task 4.
- Seconds→ms retained → Task 2 (kept; asserted via `1734200000` → `1734200000000`).
- Both `/reel/` and `/p/` handled, `media_type` derived/stored → Task 2 (derive) + Task 3 (store).
- Malformed files fail safe → Task 2 (invalid JSON, unknown shape, zero entries).
- Array + wrapper tolerance, fail safe otherwise → Task 2 (`resolveEntryList` + tests).
- Nested zip path located → already implemented; fixture refreshed in Task 5.
- Tests updated to real fixture, all green → Tasks 2–7.
- Triage cards show caption + badge → Task 6.
- Scope split (no D1/Worker change) → honoured; no schema task present.

**Placeholder scan:** none — every code step shows full code; the only prose-described edit is the `notes.md` summary (Task 7 Step 2), which is narrative documentation, not code.

**Type consistency:** `ParsedSavedItem.mediaType` and `ImportedItem.media_type` used consistently (camelCase on the parser DTO, snake_case on the stored item, matching the file's existing convention where `savedAt`→`saved_at`). `parseSavedPosts`, `toImportedItems`, `promote`, `renderItem` signatures unchanged. `ImportError` constructed with no args, matching existing usage.
