# PRD 06b — Importance/deadline UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user set 3-tier importance and an optional deadline on each reminder card in `review.html`, writing the device-owned fields 06a already built.

**Architecture:** Pure UI on `src/review-view.ts` + `review.html`. The one piece of real logic (date-string → local-midnight epoch) is extracted to a pure, headless-tested helper `src/deadline-input.ts`; the DOM controls are glue that calls the existing `pending-store` setters and pushes via the existing `drainSync`. No data-layer, engine, worker, schema, or dependency changes.

**Tech Stack:** TypeScript, Vite, Vitest (`environment: node`), IndexedDB (`idb`), vanilla DOM (no framework).

## Global Constraints

- **No new dependencies.** Use only what's installed.
- **Tests are headless** (`environment: "node"`, files under `tests/`). DOM views are untested by repo convention — do **not** add jsdom.
- **Ownership invariant (06a):** the device writes only `importance`/`deadline_at` (via the store setters, which set `synced=false`); it **never** writes `next_due_at` or any server-owned reminder-state column.
- **Deadline = local start-of-day epoch ms.** Picked `YYYY-MM-DD` → `new Date(y, m-1, d).getTime()`.
- **Commit trailer on every commit:**
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```
- Spec: `docs/superpowers/specs/2026-06-26-prd06b-importance-deadline-ui-design.md`.

## File Structure

| File | Responsibility |
|---|---|
| `src/deadline-input.ts` (new) | Pure `dateInputToEpoch(value)` — the only new unit-tested logic |
| `tests/deadline-input.test.ts` (new) | Headless tests for the helper |
| `src/review-view.ts` (modify) | `importanceRow`/`deadlineControl` DOM helpers; thread `store` into `renderCard`; wire setters + `drainSync` |
| `review.html` (modify) | CSS for the importance buttons + deadline link/set-state |

---

### Task 1: `dateInputToEpoch` pure helper

**Files:**
- Create: `src/deadline-input.ts`
- Test: `tests/deadline-input.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function dateInputToEpoch(value: string): number | null` — `"YYYY-MM-DD"` → local start-of-day epoch ms; `null` for empty/malformed/impossible dates.

- [ ] **Step 1: Write the failing test**

Create `tests/deadline-input.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { dateInputToEpoch } from "../src/deadline-input";

describe("dateInputToEpoch", () => {
  it("converts YYYY-MM-DD to a local start-of-day epoch", () => {
    expect(dateInputToEpoch("2026-07-03")).toBe(new Date(2026, 6, 3).getTime());
  });

  it("returns null for empty input", () => {
    expect(dateInputToEpoch("")).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(dateInputToEpoch("not-a-date")).toBeNull();
  });

  it("returns null for an impossible calendar date", () => {
    expect(dateInputToEpoch("2026-02-31")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- deadline-input`
Expected: FAIL — `Cannot find module '../src/deadline-input'` (file not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/deadline-input.ts`:

```ts
// Converts a native <input type="date"> value ("YYYY-MM-DD") to a local
// start-of-day epoch (ms), or null for empty/malformed/impossible input.
// Local midnight so a picked "Jul 3" drives the item due at the start of Jul 3
// in the user's own timezone (the digest/quiet-hours gate the notification time).
export function dateInputToEpoch(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mon = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mon - 1, d);
  // Reject overflow (e.g. 2026-02-31 rolls forward into March).
  if (dt.getFullYear() !== y || dt.getMonth() !== mon - 1 || dt.getDate() !== d) {
    return null;
  }
  return dt.getTime();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- deadline-input`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/deadline-input.ts tests/deadline-input.test.ts
git commit -m "$(cat <<'EOF'
feat(prd06b): dateInputToEpoch — date-input value to local-midnight epoch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Review-card importance + deadline controls

DOM glue — untested by repo convention (no jsdom). The deliverable is verified by typecheck + the full suite staying green + a manual smoke check. No test file for this task.

**Files:**
- Modify: `src/review-view.ts`
- Modify: `review.html`

**Interfaces:**
- Consumes: `dateInputToEpoch` (Task 1); `normalizeImportance` (`src/reminder/spacing.ts`); `PendingStore.setImportance`/`setDeadline` (`src/pending-store.ts`); `drainSync` (`src/sync.ts`); `Importance`, `PendingCapture` (`src/types.ts`).
- Produces: user-facing controls only; nothing downstream consumes new exports.

- [ ] **Step 1: Add imports**

In `src/review-view.ts`, replace the import block at the top (lines 1–5) with:

```ts
import { pullAndReconcile } from "./reminder-pull";
import { createPendingStore } from "./pending-store";
import type { PendingStore } from "./pending-store";
import { drainSync } from "./sync";
import { getUserId } from "./db";
import type { PendingCapture, Importance } from "./types";
import { normalizeImportance } from "./reminder/spacing";
import { dateInputToEpoch } from "./deadline-input";
```

- [ ] **Step 2: Thread the store into `renderCard`**

In `main()`, change the render call (currently `renderCard(item, userId)`) to:

```ts
  for (const item of items) listEl.appendChild(renderCard(item, userId, store));
```

Change the `renderCard` signature from `function renderCard(item: PendingCapture, userId: string): HTMLElement {` to:

```ts
function renderCard(item: PendingCapture, userId: string, store: PendingStore): HTMLElement {
```

- [ ] **Step 3: Insert the two controls into the card**

In `renderCard`, between the `link` block (ends `card.appendChild(link);`) and the `const controls = …` block, add:

```ts
  card.appendChild(importanceRow(item, store));
  card.appendChild(deadlineControl(item, store));
```

- [ ] **Step 4: Add the `importanceRow` helper**

Add at module scope in `src/review-view.ts` (e.g. above `renderCard`):

```ts
const TIERS: Importance[] = ["low", "normal", "high"];

function importanceRow(item: PendingCapture, store: PendingStore): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "importance";

  const label = document.createElement("span");
  label.className = "ctl-label";
  label.textContent = "importance";
  wrap.appendChild(label);

  let current = normalizeImportance(item.importance);
  const btns = new Map<Importance, HTMLButtonElement>();

  for (const tier of TIERS) {
    const b = document.createElement("button");
    b.className = "tier" + (tier === current ? " active" : "");
    b.textContent = tier;
    b.addEventListener("click", async () => {
      if (tier === current) return;
      try {
        await store.setImportance(item.id, tier);
        current = tier;
        for (const [t, el] of btns) el.classList.toggle("active", t === tier);
        void drainSync(store).catch(() => {});
      } catch {
        /* leave UI as-is; user can retry */
      }
    });
    btns.set(tier, b);
    wrap.appendChild(b);
  }

  return wrap;
}
```

- [ ] **Step 5: Add the `deadlineControl` helper**

Add at module scope in `src/review-view.ts`:

```ts
function deadlineControl(item: PendingCapture, store: PendingStore): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "deadline";

  const render = (deadline: number | null): void => {
    wrap.replaceChildren();

    if (deadline == null) {
      const add = document.createElement("button");
      add.className = "deadline-add";
      add.textContent = "+ Set deadline";
      add.addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "date";
        input.className = "deadline-input";
        input.addEventListener("change", async () => {
          const epoch = dateInputToEpoch(input.value);
          if (epoch == null) return; // empty / invalid → no-op
          try {
            await store.setDeadline(item.id, epoch);
            void drainSync(store).catch(() => {});
            render(epoch);
          } catch {
            /* keep the input open; user can retry */
          }
        });
        wrap.replaceChildren(input);
        input.focus();
      });
      wrap.appendChild(add);
    } else {
      const badge = document.createElement("span");
      badge.className = "deadline-set";
      badge.textContent = new Date(deadline).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });

      const clear = document.createElement("button");
      clear.className = "deadline-clear";
      clear.textContent = "×";
      clear.setAttribute("aria-label", "Clear deadline");
      clear.addEventListener("click", async () => {
        try {
          await store.setDeadline(item.id, null);
          void drainSync(store).catch(() => {});
          render(null);
        } catch {
          /* keep the badge; user can retry */
        }
      });

      wrap.append(badge, clear);
    }
  };

  render(item.deadline_at ?? null);
  return wrap;
}
```

- [ ] **Step 6: Add CSS to `review.html`**

In the `<style>` block of `review.html`, after the existing `button.done { … }` rule, add:

```css
      .importance, .deadline { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
      .ctl-label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #888; }
      button.tier { text-transform: capitalize; }
      button.tier.active { background: #1e2a3a; border-color: #3a5573; color: #b9d5f5; }
      button.deadline-add { color: #aaa; }
      .deadline-set { font-size: 13px; color: #cdb; background: #25301f; border: 1px solid #3a4a2c;
                      border-radius: 4px; padding: 2px 8px; }
      button.deadline-clear { padding: 2px 8px; line-height: 1; }
      input.deadline-input { background: #1a1a1a; color: #eee; border: 1px solid #3a3a3a;
                             border-radius: 6px; padding: 5px 8px; font-size: 14px; }
```

- [ ] **Step 7: Typecheck + full suite**

Run: `npm run build`
Expected: `tsc` passes with no errors (signature change + new imports type-check), Vite build succeeds.

Run: `npm test`
Expected: PASS — all existing tests green, plus Task 1's 4 new tests. No test regressions.

- [ ] **Step 8: Manual smoke check (DOM, not automated)**

Run: `npm run dev`, open `review.html` with at least one active reminder (or note this is covered by the deploy smoke list if no local data). Verify:
- three importance buttons render; the item's current tier is highlighted; tapping another highlights it and persists across reload (read back from the store).
- `+ Set deadline` reveals a date input; picking a date shows `[Mon D] [×]`; reload keeps the set-state.
- `×` clears it back to `+ Set deadline`.

If no local reminder data is available, record this step as deferred to the deployment smoke check and note it in `docs/manual-verification.md`.

- [ ] **Step 9: Commit**

```bash
git add src/review-view.ts review.html
git commit -m "$(cat <<'EOF'
feat(prd06b): importance buttons + optional deadline picker on review cards

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- §2.1 importance segmented buttons + active tier → Task 2 Step 4 (`importanceRow`, `normalizeImportance` active class). ✓
- §2.2 collapsed deadline, date pick → epoch, `[date][×]` set-state, clear → null, pre-set render → Task 1 + Task 2 Step 5 (`deadlineControl`). ✓
- §3 data flow: setter (`synced=false`) → `drainSync` → never writes `next_due_at` → Task 2 Steps 4–5 (only `setImportance`/`setDeadline` + `drainSync`; no `next_due_at` touched). ✓
- §4 testability split: pure helper tested, DOM glue untested → Task 1 (tested) + Task 2 (untested glue). ✓
- §6 files: `deadline-input.ts`, its test, `review-view.ts`, `review.html` → all tasks. ✓
- §7 tests: 3+ headless cases for `dateInputToEpoch` → Task 1 Step 1 (4 cases incl. overflow). ✓
- §8 acceptance: 3-tier one-tap default normal; setter device-owned + push; optional collapsed deadline; local-midnight epoch + null clear; legacy `matters`→`high` display; existing high-first order unchanged → covered by Tasks 1–2; high-first sort untouched (existing code at `review-view.ts` sort). ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". All code shown in full. ✓

**Type consistency:** `dateInputToEpoch(value: string): number | null` defined in Task 1, consumed in Task 2 Step 5 with that exact signature. `renderCard(item, userId, store)` defined in Step 2, called in Step 2's `main()` change with matching args. `setImportance(id, Importance)` / `setDeadline(id, number | null)` match `PendingStore` (pending-store.ts). `drainSync(store)` matches `src/sync.ts`. `TIERS: Importance[]` matches the `Importance` union. ✓
