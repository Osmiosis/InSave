# PRD 06c — Deadline surfacing reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a user-set deadline reliably surface its item (at/after the deadline, including a deadline already in the past), bypassing the cadence gate but respecting quiet hours, and firing exactly once.

**Architecture:** Replace 06a's `effectiveNextDue` deadline-override (which only ever delayed an item, never fired it, and had a boundary bug) with an *additional* due-condition in `selectDue`: an active item is due when `next_due_at <= now` **or** it has an unserviced reached deadline (`deadline_at <= now && last_surfaced_at < deadline_at`). The cron lets a deadline-driven surfacing skip the cadence gate. Quiet hours are unchanged. Fire-once and past-deadline handling both fall out of the `last_surfaced_at < deadline_at` test — no new column.

**Tech Stack:** TypeScript, Vitest (`environment: node`), Cloudflare Worker cron. All headless; no UI/schema/dependency change.

## Global Constraints

- **No schema, UI, worker-sync, or dependency change.** Engine + cron only.
- **Tests are headless** (`environment: "node"`, under `tests/`).
- **"Sooner is fine":** a deadline must NOT delay normal surfacing and must NOT keep the item quiet before the deadline. It only adds a "fire by this time" guarantee.
- **Bypass cadence, respect quiet hours:** a deadline-driven surfacing skips the cadence gate but still waits for quiet hours to end.
- **Fire exactly once:** reuse the server-owned `last_surfaced_at`; no new field. After surfacing, `advance` sets `last_surfaced_at = now (>= deadline_at)`, flipping the deadline clause false.
- **Ownership (06a):** the cron owns `next_due_at`/`last_surfaced_at`; the device owns `deadline_at`. Unchanged.
- **Task ordering keeps every task's build green:** digest first (stops importing `effectiveNextDue`), then spacing (removes it) + the cron lazy-init call, then the cron cadence bypass.
- **Commit trailer on every commit:**
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```
- Spec: `docs/superpowers/specs/2026-06-26-prd06c-deadline-surfacing-design.md`.

## File Structure

| File | Responsibility |
|---|---|
| `src/reminder/digest.ts` | new `isDeadlineDue`; `selectDue` due-clause; drop `effectiveNextDue` import (Task 1) |
| `src/reminder/spacing.ts` | remove `effectiveNextDue`; `initialState`/`advance` drop the `next_due` override (Task 2) |
| `worker/cron.ts` | lazy-init drops deadline arg (Task 2); cadence bypass via `hasDeadlineDue` (Task 3) |
| `tests/reminder/{digest,spacing,cron}.test.ts` | update 06a deadline tests + add new cases |

---

### Task 1: Deadline due-clause in the digest

**Files:**
- Modify: `src/reminder/digest.ts`
- Test: `tests/reminder/digest.test.ts`, `tests/reminder/cron.test.ts` (delete one now-obsolete test — `selectDue`'s new clause changes cron behavior, so the old-semantics cron test must go in this task to keep the suite green)

**Interfaces:**
- Consumes: `PendingCapture` (`src/types.ts`); `normalizeImportance`, `DAY` (`src/reminder/spacing.ts`).
- Produces: `export function isDeadlineDue(item: PendingCapture, now: number): boolean`; `selectDue` unchanged signature.

- [ ] **Step 1: Write the failing tests**

In `tests/reminder/digest.test.ts`, update the import on line 2 to add `isDeadlineDue`:

```ts
import { selectDue, isDeadlineDue, isQuietHours, cadenceGate, DIGEST_CAP, CADENCE_GAP } from "../../src/reminder/digest";
```

Replace the existing test `it("does not select an item whose future deadline gates it, even if next_due_at is past", ...)` (the whole `it(...)` block) with these three tests:

```ts
  it("selects a past-next_due item even with a future deadline (sooner is fine)", () => {
    const s = item({ id: "s", importance: "normal", next_due_at: 1, deadline_at: 10_000 });
    expect(selectDue([s], settings(), 1000).map((i) => i.id)).toEqual(["s"]);
  });

  it("selects a future-next_due item once its deadline is reached and unserviced", () => {
    const d = item({ id: "d", next_due_at: 10_000, deadline_at: 500 });
    expect(selectDue([d], settings(), 1000).map((i) => i.id)).toEqual(["d"]);
  });

  it("does not re-select a deadline item already serviced (last_surfaced_at >= deadline_at)", () => {
    const served = item({ id: "d", next_due_at: 10_000, deadline_at: 500, last_surfaced_at: 600 });
    expect(selectDue([served], settings(), 1000).map((i) => i.id)).toEqual([]);
  });
```

Then add a new `describe` block (e.g. after the `selectDue` describe):

```ts
describe("isDeadlineDue", () => {
  it("true when the deadline is reached and unserviced", () => {
    expect(isDeadlineDue(item({ deadline_at: 500, last_surfaced_at: 0 }), 1000)).toBe(true);
  });
  it("false when the deadline is still in the future", () => {
    expect(isDeadlineDue(item({ deadline_at: 5000 }), 1000)).toBe(false);
  });
  it("false when already serviced (last_surfaced_at >= deadline_at)", () => {
    expect(isDeadlineDue(item({ deadline_at: 500, last_surfaced_at: 500 }), 1000)).toBe(false);
  });
  it("false when there is no deadline", () => {
    expect(isDeadlineDue(item({}), 1000)).toBe(false);
  });
});
```

Also, in `tests/reminder/cron.test.ts`, **delete** the existing test
`it("holds a future-deadline item until its deadline, then surfaces it", ...)` (the whole `it(...)`
block). It asserts the old "quiet until deadline" gating that this task's `selectDue` change overturns
(a past `next_due_at` now surfaces immediately — "sooner is fine"); leaving it in would fail the suite
after this task. (The new cron tests are added in Task 3.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- digest`
Expected: FAIL — `isDeadlineDue` is not exported; the "selects a past-next_due item even with a future deadline" test fails under the old `effectiveNextDue` gating.

- [ ] **Step 3: Implement**

In `src/reminder/digest.ts`, change the import on line 2 to drop `effectiveNextDue` (keep `DAY`, `normalizeImportance`):

```ts
import { DAY, normalizeImportance } from "./spacing";
```

Add the helper (e.g. above `selectDue`):

```ts
// A deadline is "due" once it has been reached but the item has not been
// surfaced since the deadline time. Reusing last_surfaced_at makes the firing
// exactly-once (advance writes last_surfaced_at = now on surfacing) and covers
// a deadline that was already in the past when set.
export function isDeadlineDue(item: PendingCapture, now: number): boolean {
  return item.deadline_at != null
    && item.deadline_at <= now
    && (item.last_surfaced_at ?? 0) < item.deadline_at;
}
```

Replace the `.filter(...)` inside `selectDue` with:

```ts
    .filter(
      (i) =>
        i.reminder_status === "active" &&
        ((i.next_due_at ?? Infinity) <= now || isDeadlineDue(i, now)),
    )
```

(The `.sort(...)` and `.slice(0, DIGEST_CAP)` are unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — the full suite (the `selectDue` change affects the cron, and the obsolete cron test was removed in Step 1).

- [ ] **Step 5: Commit**

```bash
git add src/reminder/digest.ts tests/reminder/digest.test.ts tests/reminder/cron.test.ts
git commit -m "$(cat <<'EOF'
feat(prd06c): deadline-due clause in selectDue (fires on a reached unserviced deadline)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Remove the next_due deadline override from the spacing engine

**Files:**
- Modify: `src/reminder/spacing.ts`, `worker/cron.ts`
- Test: `tests/reminder/spacing.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `initialState(importance: unknown, now: number): ReminderState` (deadline param removed); `advance` unchanged signature but `next_due_at = now + interval` (no override). `effectiveNextDue` is removed (no longer exported).

- [ ] **Step 1: Update the failing tests**

In `tests/reminder/spacing.test.ts`:

(a) Line 2 — drop `effectiveNextDue` from the import:

```ts
import { initialState, advance, PRESETS, DAY, presetFor, normalizeImportance } from "../../src/reminder/spacing";
```

(b) Delete the entire `describe("effectiveNextDue", () => { ... })` block.

(c) Replace the entire `describe("spacing deadline override", () => { ... })` block with:

```ts
describe("spacing — deadline no longer drives next_due (sooner is fine)", () => {
  it("initialState seeds tier next_due and takes no deadline argument", () => {
    expect(initialState("normal", 1000).next_due_at).toBe(1000 + PRESETS.normal.initialDelay);
  });
  it("advance keeps a future-deadline item active even past maxCycles, but next_due is tier-driven (not the deadline)", () => {
    const a = advance(item({ importance: "normal", cycle_count: 99, deadline_at: 9_000 }), 1_000);
    expect(a.reminder_status).toBe("active");
    expect(a.next_due_at).not.toBe(9_000);
    expect(a.next_due_at).toBeGreaterThan(1_000);
  });
  it("advance lets a past-deadline item expire normally past maxCycles", () => {
    const a = advance(item({ importance: "normal", cycle_count: 99, deadline_at: 500 }), 1_000);
    expect(a.reminder_status).toBe("expired");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- spacing`
Expected: FAIL — `effectiveNextDue` import is gone but still exists; the new `advance` assertions fail while `next_due_at` is still the deadline (`9_000`). (Compilation/assertion failure is fine.)

- [ ] **Step 3: Implement**

In `src/reminder/spacing.ts`:

(a) Delete the `effectiveNextDue` function (lines 39–43, including its doc comment).

(b) Replace `initialState` with (drop the `deadline_at` param + override):

```ts
export function initialState(importance: unknown, now: number): ReminderState {
  return {
    reminder_status: "active",
    cycle_count: 0,
    ignored_count: 0,
    next_due_at: now + presetFor(importance).initialDelay,
  };
}
```

(c) In `advance`, change the returned `next_due_at` from
`next_due_at: effectiveNextDue(now + interval, item.deadline_at, now),`
to:

```ts
    next_due_at: now + interval,
```

Leave the rest of `advance` unchanged — in particular keep
`const deadlineActive = item.deadline_at != null && item.deadline_at > now;`
and `reminder_status: deadlineActive ? "active" : (expired ? "expired" : "active"),` (the anti-expiry guard so a future-deadline item still lives to fire at its deadline).

In `worker/cron.ts`, change the lazy-init call (drop the deadline arg):

```ts
        const seed = initialState(it.importance, now);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- spacing`
Expected: PASS. Then run the full suite to confirm the signature change didn't break the cron:
Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 5: Commit**

```bash
git add src/reminder/spacing.ts worker/cron.ts tests/reminder/spacing.test.ts
git commit -m "$(cat <<'EOF'
feat(prd06c): drop effectiveNextDue; deadline no longer overrides next_due

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Cadence bypass for a deadline-driven surfacing

**Files:**
- Modify: `worker/cron.ts`
- Test: `tests/reminder/cron.test.ts`

**Interfaces:**
- Consumes: `isDeadlineDue` (Task 1, `src/reminder/digest.ts`); `selectDue`, `isQuietHours`, `cadenceGate` (already imported).
- Produces: cron behavior only.

- [ ] **Step 1: Write the failing tests**

In `tests/reminder/cron.test.ts` (the old "holds a future-deadline item until its deadline" test was already deleted in Task 1), add these five tests inside the `describe("runCron", ...)`:

```ts
  it("surfaces a past-next_due item immediately despite a future deadline (sooner is fine)", async () => {
    const { repo } = fakeRepo(
      [item({ id: "d", reminder_status: "active", cycle_count: 0, next_due_at: NOON - DAY, deadline_at: NOON + 10 * DAY })],
      [neverQuiet()],
    );
    const { sent, notify } = capturingNotify();
    await runCron(repo, NOON, notify);
    expect(sent).toEqual([{ userId: "u1", ids: ["d"] }]); // not held until the deadline
  });

  it("surfaces a reached-deadline item and bypasses the cadence gate", async () => {
    const recent = { ...neverQuiet(), last_digest_at: NOON - 3_600_000 }; // 1h ago; balanced gap 2d → cadence would block
    const { repo, itemMap } = fakeRepo(
      [item({ id: "d", reminder_status: "active", cycle_count: 0, next_due_at: NOON + 10 * DAY, deadline_at: NOON - DAY })],
      [recent],
    );
    const { sent, notify } = capturingNotify();
    await runCron(repo, NOON, notify);
    expect(sent).toEqual([{ userId: "u1", ids: ["d"] }]);
    expect(itemMap.get("d")!.last_surfaced_at).toBe(NOON);
  });

  it("still blocks a non-deadline due item under the cadence gate (bypass is deadline-only)", async () => {
    const recent = { ...neverQuiet(), last_digest_at: NOON - 3_600_000 }; // 1h ago
    const { repo } = fakeRepo(
      [item({ id: "a", reminder_status: "active", cycle_count: 0, next_due_at: NOON - DAY })], // due, no deadline
      [recent],
    );
    const { sent, notify } = capturingNotify();
    await runCron(repo, NOON, notify);
    expect(sent).toEqual([]); // cadence still gates a plain due item
  });

  it("surfaces a reached-deadline item exactly once across consecutive ticks", async () => {
    const { repo } = fakeRepo(
      [item({ id: "d", reminder_status: "active", cycle_count: 0, next_due_at: NOON + 10 * DAY, deadline_at: NOON - DAY })],
      [neverQuiet()],
    );
    const { sent, notify } = capturingNotify();
    await runCron(repo, NOON, notify);            // tick 1: surfaces (last_surfaced = NOON)
    await runCron(repo, NOON + DAY, notify);        // tick 2: last_surfaced(NOON) >= deadline(NOON-DAY) → not re-selected
    expect(sent).toEqual([{ userId: "u1", ids: ["d"] }]);
  });

  it("does not surface a reached-deadline item during quiet hours; surfaces once quiet ends", async () => {
    const quiet = { ...defaultSettings("u1", "UTC"), quiet_start: 0, quiet_end: 23 }; // 12:00 quiet, 23:00 not
    const { repo, itemMap } = fakeRepo(
      [item({ id: "d", reminder_status: "active", cycle_count: 0, next_due_at: NOON + 10 * DAY, deadline_at: NOON - DAY })],
      [quiet],
    );
    const capA = capturingNotify();
    await runCron(repo, NOON, capA.notify);          // quiet → suppressed
    expect(capA.sent).toEqual([]);
    expect(itemMap.get("d")!.last_surfaced_at).toBeUndefined();

    const nonQuiet = Date.UTC(2026, 0, 1, 23, 0, 0);
    const capB = capturingNotify();
    await runCron(repo, nonQuiet, capB.notify);      // still unserviced → surfaces
    expect(capB.sent).toEqual([{ userId: "u1", ids: ["d"] }]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- cron`
Expected: FAIL — the cadence-bypass test fails (cadence gate currently blocks the deadline item); the quiet-then-surface and exactly-once tests may also fail until the bypass + due-clause are wired.

- [ ] **Step 3: Implement**

In `worker/cron.ts`, add `isDeadlineDue` to the digest import:

```ts
import { selectDue, isQuietHours, cadenceGate, isDeadlineDue } from "./reminder/digest";
```

(Match the existing relative path used for the other digest imports in this file — `./reminder/digest` from `worker/cron.ts`.)

Replace the cadence-gate block (currently `const hasHigh = …; if (!cadenceGate(settings, now, hasHigh)) continue;`) with:

```ts
      const hasHigh = due.some((d) => normalizeImportance(d.importance) === "high");
      const hasDeadlineDue = due.some((d) => isDeadlineDue(d, now));
      if (!cadenceGate(settings, now, hasHigh) && !hasDeadlineDue) continue;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- cron`
Expected: PASS. Then the full suite + typecheck:
Run: `npm run build && npm test`
Expected: `tsc` clean, Vite build OK, all suites green.

- [ ] **Step 5: Commit**

```bash
git add worker/cron.ts tests/reminder/cron.test.ts
git commit -m "$(cat <<'EOF'
feat(prd06c): cron lets a reached deadline bypass the cadence gate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- §2 due-clause (`next_due <= now` OR unserviced reached deadline) → Task 1 (`isDeadlineDue` + `selectDue`). ✓
- §3 remove `effectiveNextDue`; `initialState`/`advance` drop the override; keep anti-expiry guard → Task 2. ✓
- §4 `isDeadlineDue` helper + `selectDue` → Task 1. ✓
- §5 lazy-init drops deadline arg (Task 2); cadence bypass via `hasDeadlineDue` (Task 3); quiet hours unchanged (no edit). ✓
- §8 tests: initialState/advance new semantics (Task 2); `isDeadlineDue` + selectDue past-deadline/serviced/sooner (Task 1); cron bypass + once + quiet (Task 3). ✓
- §9 acceptance: deadline surfaces (Task 1+3), bypasses cadence (Task 3), respects quiet (Task 3 test), fires once (Task 1 serviced + Task 3 once), never delays (Task 1 sooner-is-fine), ownership unchanged (no sync edit). ✓

**Placeholder scan:** none.

**Type consistency:** `isDeadlineDue(item: PendingCapture, now: number): boolean` defined in Task 1, imported in Task 3 cron. `initialState(importance, now)` (2-arg) set in Task 2, called 2-arg in cron (Task 2) and tests. `advance` signature unchanged. `selectDue` signature unchanged. `last_surfaced_at`/`deadline_at`/`next_due_at` are existing `PendingCapture` fields. Ordering (digest → spacing+cron-lazyinit → cron-cadence) keeps each task's `tsc`+suite green: Task 1 leaves `effectiveNextDue` exported-but-only-used-internally; Task 2 removes it and fixes its sole remaining caller (the cron lazy-init line) in the same task.
