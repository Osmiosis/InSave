# PRD 06a — Importance tiers + deadlines (data + engine) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace binary importance with 3 tiers (low/normal/high), add an optional device-owned `deadline_at` that the cron engine honours, migrate existing `matters`→`high`, and update spacing/digest/cron/sync — all headless/TDD.

**Architecture:** `Importance` becomes `low|normal|high`; a single `normalizeImportance` coercion (legacy `matters`→`high`, unknown→`normal`) makes correctness independent of stored values. The spacing engine grows from 2 to 3 parameterised curves plus a deadline override (`effectiveNextDue`) that lives entirely server-side in the cron — the device only writes the device-owned `deadline_at`, never the server-owned `next_due_at`.

**Tech Stack:** TypeScript, IndexedDB via `idb`, Cloudflare D1/Worker, Vitest (node env, fake-indexeddb). No new dependencies.

## Global Constraints

- **No new runtime dependencies.**
- **`Importance = "low" | "normal" | "high"`**, default `normal`. Legacy `"matters"` ≡ `"high"` via `normalizeImportance`; `null`/`undefined`/unknown ≡ `"normal"`.
- **`high` reuses the old `matters` spacing numbers** (initialDelay 1d, growth 1.6, maxCycles 8, maxAge 90d) so migrated items behave identically. `normal` is unchanged. `low` is gentle (7d / 2.5 / 2 / 21d). These are tuning values (PRD §7).
- **Deadline rule:** a `deadline_at` in the future drives `next_due_at` to the deadline (item quiet until then) and keeps the item `active` (not tier-expired) until the deadline; once the deadline is in the past the override is inert and tier spacing resumes (snooze already uses the tier curve — unchanged).
- **Ownership:** `importance` + `deadline_at` are **device-owned content** (`synced=false` on write, ride `/api/sync`). The five reminder-state columns stay **server-owned**; the device never writes `next_due_at`. The deadline override is computed in `worker/cron.ts` + `spacing.ts`, not on the device.
- **Test env is `node`** — headless tests only.
- **Run `npx tsc --noEmit && npx vitest run` at each task's verify step.** Baseline at branch HEAD: 151 tests green.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: `Importance` → 3 tiers + `normalizeImportance` + 3 presets + 3-tier ranking (foundation)

**Files:**
- Modify: `src/types.ts`
- Modify: `src/reminder/spacing.ts`
- Modify: `src/reminder/digest.ts` (rank → 3-tier)
- Modify: `worker/cron.ts` (`hasMatters` → `hasHigh`)
- Modify: `src/review-view.ts` (rank → high-first; compile-forced by the union change)
- Modify (mechanical `matters`→`high` sweep + new cases): `tests/reminder/spacing.test.ts`, `tests/reminder/digest.test.ts`
- Modify (mechanical `matters`→`high` sweep): `tests/reminder/action.test.ts`, `tests/reminder/response.test.ts`, `tests/reminder/reconcile-pull.test.ts`, `tests/pending-store.test.ts`

**Interfaces:**
- Consumes: existing `Preset`, `PRESETS`, `presetFor`, `initialState`, `advance`, `selectDue`.
- Produces:
  - `Importance = "low" | "normal" | "high"`; `PendingCapture.deadline_at?: number`.
  - `normalizeImportance(raw: unknown): Importance`.
  - `PRESETS: Record<Importance, Preset>` with `low`/`normal`/`high`; `presetFor(importance: unknown): Preset`.
  - `selectDue` rank: `high < normal < low` (via `normalizeImportance`). The due-filter stays `next_due_at`-based here; Task 3 makes it deadline-aware.

This task changes the `Importance` union. That makes every test literal `importance: "matters"` a type error, every `PRESETS.matters` a missing-property error, AND the three source branches that compare `=== "matters"` (`digest.ts` rank, `cron.ts` cadence flag, `review-view.ts` rank) type errors (`"matters"` no longer overlaps the union). All of these must change together so tsc + the suite stay green. Because `high` reuses the old `matters` numbers, behaviour is unchanged for migrated items.

- [ ] **Step 1: Edit `src/types.ts`**

Change the union and add the field:

```ts
export type Importance = "low" | "normal" | "high";
```

In the `PendingCapture` interface, add after the `importance?` line (next to the other device-owned content fields like `collection_id`):

```ts
  importance?: Importance;
  deadline_at?: number;   // epoch ms; null/undefined ≡ no deadline (device-owned)
```

- [ ] **Step 2: Edit `src/reminder/spacing.ts`** — add `normalizeImportance`, 3 presets, `presetFor` via normalize

Make three surgical edits; **do NOT touch `IGNORE_THRESHOLD`/`IGNORE_ACCEL` (lines ~18–19) or `initialState`/`advance`** (those are Task 2):

1. Replace the `PRESETS` constant (the current 2-entry `matters`/`normal` object, lines ~12–16) with the 3-entry version, and add `normalizeImportance` directly above it:

```ts
export function normalizeImportance(raw: unknown): Importance {
  if (raw === "low" || raw === "normal" || raw === "high") return raw;
  if (raw === "matters") return "high"; // legacy PRD 03 value
  return "normal";                       // null / undefined / unknown
}

// Tuning values (PRD 06a §3.1) — expect to adjust against a real backlog.
export const PRESETS: Record<Importance, Preset> = {
  high:   { initialDelay: 1 * DAY, growth: 1.6, maxCycles: 8, maxAge: 90 * DAY }, // was "matters"
  normal: { initialDelay: 3 * DAY, growth: 2.0, maxCycles: 4, maxAge: 45 * DAY },
  low:    { initialDelay: 7 * DAY, growth: 2.5, maxCycles: 2, maxAge: 21 * DAY },
};
```

2. Replace `presetFor` (lines ~21–23) so it accepts `unknown` and routes through normalize:

```ts
export function presetFor(importance: unknown): Preset {
  return PRESETS[normalizeImportance(importance)];
}
```

`spacing.ts` already imports `Importance` from `../types`, so no import change is needed.

- [ ] **Step 3: Update the source branches that compared `=== "matters"`**

`src/reminder/digest.ts` — add `normalizeImportance` to the import from `./spacing` and replace the `rank` line in `selectDue` (line ~17) with a 3-tier order (high first, low last):

```ts
  const order: Record<string, number> = { high: 0, normal: 1, low: 2 };
  const rank = (i: PendingCapture) => order[normalizeImportance(i.importance)];
```

`worker/cron.ts` — add `normalizeImportance` to the import from `../src/reminder/spacing`, and swap the cadence flag (lines ~43–44):

```ts
    const hasHigh = due.some((d) => normalizeImportance(d.importance) === "high");
    if (!cadenceGate(settings, now, hasHigh)) continue;
```

`src/review-view.ts` — the rank at line ~39 (`x.importance === "matters" ? 0 : 1`) no longer compiles. Replace with high-first via normalize (import `normalizeImportance` from `./reminder/spacing`):

```ts
      const order: Record<string, number> = { high: 0, normal: 1, low: 2 };
      const rank = (x: PendingCapture) => order[normalizeImportance(x.importance)];
```

(06b adds the importance/deadline *controls* + any review layout polish; this is just the compile-forced rank rename, made correct for 3 tiers.)

- [ ] **Step 4: Sweep `matters`→`high` in the existing tests**

Make these exact replacements so tsc + the suite stay green:

- `tests/reminder/spacing.test.ts`:
  - line 16: `initialState("matters", 1000)` → `initialState("high", 1000)`
  - line 18: `PRESETS.matters.initialDelay` → `PRESETS.high.initialDelay`
  - line 36: `item({ importance: "matters", cycle_count: 0 })` → `item({ importance: "high", cycle_count: 0 })`
  - line 47: `item({ importance: "matters", cycle_count: 1, tagged_at: 0 })` → `item({ importance: "high", cycle_count: 1, tagged_at: 0 })`
  - line 48: `PRESETS.matters.maxAge` → `PRESETS.high.maxAge`
  - line 35 description `"matters resurfaces sooner…"` → `"high resurfaces sooner…"` (cosmetic)
- `tests/reminder/action.test.ts`:
  - line 10: `importance: "matters",` → `importance: "high",`
  - line 21: `presetFor("matters")` → `presetFor("high")`
- `tests/reminder/response.test.ts`:
  - line 20: `item({ importance: "matters" })` → `item({ importance: "high" })`
  - line 22: `presetFor("matters")` → `presetFor("high")`
- `tests/reminder/digest.test.ts`:
  - line 32: `importance: "matters"` → `importance: "high"`
  - line 33: `importance: "matters"` → `importance: "high"`
  - line 29 & 75 descriptions `matters` → `high` (cosmetic)
- `tests/reminder/reconcile-pull.test.ts`:
  - line 19: `importance: "matters"` → `importance: "high"`
  - line 24: `expect(merged.importance).toBe("matters")` → `…toBe("high")`
- `tests/pending-store.test.ts`:
  - line 69: `importance: "matters"` → `importance: "high"`
  - line 75: `expect(r.importance).toBe("matters")` → `…toBe("high")`

(Leave `tests/reminder/row-to-pending.test.ts:9`'s `importance: "matters"` as-is — it's a raw D1 row `Record<string, unknown>`, not a typed literal; Task 5 adds a normalize assertion there.)

- [ ] **Step 5: Add new tests**

Append to `tests/reminder/digest.test.ts` (inside `describe("selectDue", …)`) a 3-tier ordering case:

```ts
  it("ranks high before normal before low", () => {
    const due = selectDue([
      item({ id: "lo", importance: "low", next_due_at: 1 }),
      item({ id: "hi", importance: "high", next_due_at: 1 }),
      item({ id: "no", importance: "normal", next_due_at: 1 }),
    ], settings(), 1000);
    expect(due.map((i) => i.id)).toEqual(["hi", "no", "lo"]);
  });
```

Append to `tests/reminder/spacing.test.ts`:

```ts
import { normalizeImportance } from "../../src/reminder/spacing";

describe("normalizeImportance", () => {
  it("passes low/normal/high through", () => {
    expect(normalizeImportance("low")).toBe("low");
    expect(normalizeImportance("normal")).toBe("normal");
    expect(normalizeImportance("high")).toBe("high");
  });
  it("maps legacy matters to high", () => {
    expect(normalizeImportance("matters")).toBe("high");
  });
  it("defaults null/undefined/unknown to normal", () => {
    expect(normalizeImportance(undefined)).toBe("normal");
    expect(normalizeImportance(null)).toBe("normal");
    expect(normalizeImportance("garbage")).toBe("normal");
  });
});

describe("spacing tiers", () => {
  it("has three distinct presets; low is the widest initial gap, high the smallest", () => {
    expect(PRESETS.high.initialDelay).toBeLessThan(PRESETS.normal.initialDelay);
    expect(PRESETS.normal.initialDelay).toBeLessThan(PRESETS.low.initialDelay);
  });
  it("presetFor maps legacy matters to the high preset", () => {
    expect(presetFor("matters")).toBe(PRESETS.high);
  });
  it("presetFor defaults unknown to the normal preset", () => {
    expect(presetFor(undefined)).toBe(PRESETS.normal);
  });
});
```

Add `presetFor` and `normalizeImportance` to the existing import from `../../src/reminder/spacing` at the top of the file (it currently imports `initialState, advance, PRESETS, DAY`).

- [ ] **Step 6: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all green (151 + the new normalize/tier/ordering cases). The swept tests pass unchanged in value because `high` reuses the old `matters` numbers, and the digest ordering test still yields `["m2","m1","n1"]` under the 3-tier rank.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/reminder/spacing.ts src/reminder/digest.ts worker/cron.ts src/review-view.ts tests/
git commit -m "feat(prd06a): Importance low|normal|high + normalizeImportance + 3 presets + 3-tier rank"
```

---

### Task 2: Deadline override in the spacing engine

**Files:**
- Modify: `src/reminder/spacing.ts`
- Modify: `tests/reminder/spacing.test.ts`

**Interfaces:**
- Consumes: `PRESETS`, `presetFor`, `Preset`.
- Produces:
  - `effectiveNextDue(tierNextDue: number, deadline_at: number | undefined, now: number): number`
  - `initialState(importance: unknown, now: number, deadline_at?: number): ReminderState`
  - `advance(item, now)` — `next_due_at` via `effectiveNextDue`; forces `active`/non-expired while a deadline is in the future.

- [ ] **Step 1: Write failing tests** — append to `tests/reminder/spacing.test.ts`

```ts
import { effectiveNextDue } from "../../src/reminder/spacing";

describe("effectiveNextDue", () => {
  it("returns the deadline when it is in the future", () => {
    expect(effectiveNextDue(500, 800, 100)).toBe(800);
  });
  it("returns the tier next-due when the deadline is absent or past", () => {
    expect(effectiveNextDue(500, undefined, 100)).toBe(500);
    expect(effectiveNextDue(500, 50, 100)).toBe(500); // deadline already passed
  });
});

describe("spacing deadline override", () => {
  it("initialState drives next_due_at to a future deadline", () => {
    const s = initialState("normal", 1000, 5000);
    expect(s.next_due_at).toBe(5000);
  });
  it("initialState ignores a past deadline (tier spacing)", () => {
    const s = initialState("normal", 10_000, 5000);
    expect(s.next_due_at).toBe(10_000 + PRESETS.normal.initialDelay);
  });
  it("advance keeps a future-deadline item active and due at the deadline, even past maxCycles", () => {
    const a = advance(item({ importance: "normal", cycle_count: 99, deadline_at: 9_000 }), 1_000);
    expect(a.reminder_status).toBe("active");
    expect(a.next_due_at).toBe(9_000);
  });
  it("advance reverts to tier spacing once the deadline is past", () => {
    const a = advance(item({ importance: "normal", cycle_count: 0, deadline_at: 500 }), 1_000);
    expect(a.next_due_at).toBe(1_000 + PRESETS.normal.initialDelay);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/reminder/spacing.test.ts`
Expected: FAIL — `effectiveNextDue` not exported; `initialState` ignores the 3rd arg; `advance` expires the high-cycle item.

- [ ] **Step 3: Implement** — edit `src/reminder/spacing.ts`

Add the helper after `presetFor`:

```ts
// A future deadline overrides tier spacing: the item is scheduled to the deadline
// and stays quiet until then. Once the deadline is past, tier spacing resumes.
export function effectiveNextDue(tierNextDue: number, deadline_at: number | undefined, now: number): number {
  return deadline_at != null && deadline_at > now ? deadline_at : tierNextDue;
}
```

Change `initialState` to take an optional `deadline_at` and route through the helper:

```ts
export function initialState(importance: unknown, now: number, deadline_at?: number): ReminderState {
  return {
    reminder_status: "active",
    cycle_count: 0,
    ignored_count: 0,
    next_due_at: effectiveNextDue(now + presetFor(importance).initialDelay, deadline_at, now),
  };
}
```

In `advance`, after computing `interval`/`nextCycle`/`expired`, override for a future deadline:

```ts
  const expired = nextCycle > p.maxCycles || now - loopEntry > ageHorizon;
  const deadlineActive = item.deadline_at != null && item.deadline_at > now;
  return {
    reminder_status: deadlineActive ? "active" : (expired ? "expired" : "active"),
    next_due_at: effectiveNextDue(now + interval, item.deadline_at, now),
    cycle_count: nextCycle,
    last_surfaced_at: now,
  };
```

(`presetFor` already accepts `unknown`, so `advance`'s existing `presetFor(item.importance)` is unchanged.)

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/reminder/spacing.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all green.

- [ ] **Step 6: Commit**

```bash
git add src/reminder/spacing.ts tests/reminder/spacing.test.ts
git commit -m "feat(prd06a): deadline override in spacing engine (quiet-until-deadline)"
```

---

### Task 3: Deadline-aware `selectDue` gate + cron passes deadline to lazy-init

(The 3-tier rank and `hasHigh` cadence already landed in Task 1; this task adds only the deadline *gate* and threads `deadline_at` into lazy-init.)

**Files:**
- Modify: `src/reminder/digest.ts` (the `selectDue` filter only)
- Modify: `worker/cron.ts` (pass `deadline_at` to `initialState`)
- Modify: `tests/reminder/digest.test.ts`
- Modify: `tests/reminder/cron.test.ts`

**Interfaces:**
- Consumes: `effectiveNextDue` (Task 2), the 3-tier `selectDue` rank (Task 1), `initialState(importance, now, deadline_at?)` (Task 2).
- Produces: an item with a future `deadline_at` is not "due" until the deadline (even with a stale-earlier `next_due_at`); cron seeds new items with their deadline.

- [ ] **Step 1: Write failing tests**

Append to `tests/reminder/digest.test.ts` (inside `describe("selectDue", …)`):

```ts
  it("does not select an item whose future deadline gates it, even if next_due_at is past", () => {
    const gated = item({ id: "g", importance: "normal", next_due_at: 1, deadline_at: 10_000 });
    expect(selectDue([gated], settings(), 1000).map((i) => i.id)).toEqual([]);
    expect(selectDue([gated], settings(), 10_000).map((i) => i.id)).toEqual(["g"]);
  });
```

Append to `tests/reminder/cron.test.ts` (inside `describe("runCron", …)`, reusing its `item`/`fakeRepo`/`capturingNotify`/`neverQuiet`/`NOON`/`DAY` harness):

```ts
  it("holds a future-deadline item until its deadline, then surfaces it", async () => {
    const future = NOON + 10 * DAY;
    const before = fakeRepo(
      [item({ id: "d", reminder_status: "active", cycle_count: 0, next_due_at: NOON - DAY, deadline_at: future })],
      [neverQuiet()],
    );
    const capA = capturingNotify();
    await runCron(before.repo, NOON, capA.notify);     // before the deadline: gated despite a past next_due_at
    expect(capA.sent).toEqual([]);
    expect(before.itemMap.get("d")!.cycle_count).toBe(0);

    const at = fakeRepo(
      [item({ id: "d", reminder_status: "active", cycle_count: 0, next_due_at: NOON - DAY, deadline_at: future })],
      [neverQuiet()],
    );
    const capB = capturingNotify();
    await runCron(at.repo, future, capB.notify);        // at the deadline: surfaces
    expect(capB.sent).toEqual([{ userId: "u1", ids: ["d"] }]);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/reminder/digest.test.ts tests/reminder/cron.test.ts`
Expected: FAIL — `selectDue` ignores `deadline_at` (the gated item is selected at `now=1000`); the cron surfaces the deadline item before its deadline.

- [ ] **Step 3: Edit `src/reminder/digest.ts`** — make the due-filter deadline-aware

Extend the import (Task 1 already added `normalizeImportance`):

```ts
import { DAY, effectiveNextDue, normalizeImportance } from "./spacing";
```

Change only the `.filter(...)` predicate in `selectDue` to gate on the deadline-aware next-due:

```ts
    .filter(
      (i) =>
        i.reminder_status === "active" &&
        effectiveNextDue(i.next_due_at ?? Infinity, i.deadline_at, now) <= now,
    )
```

(Leave the Task-1 `order`/`rank` and the `.sort(...)`/`.slice(...)` as they are.)

- [ ] **Step 4: Edit `worker/cron.ts`** — pass the deadline to lazy-init (line ~26)

```ts
        const seed = initialState(it.importance, now, it.deadline_at);
```

(`normalizeImportance` and the `hasHigh` cadence were already added to `cron.ts` in Task 1.)

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run tests/reminder/digest.test.ts tests/reminder/cron.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all green.

- [ ] **Step 7: Commit**

```bash
git add src/reminder/digest.ts worker/cron.ts tests/reminder/digest.test.ts tests/reminder/cron.test.ts
git commit -m "feat(prd06a): deadline-aware selectDue gate + cron seeds deadline on lazy-init"
```

---

### Task 4: pending-store `setImportance`/`setDeadline` + local `matters→high` migration

**Files:**
- Modify: `src/pending-store.ts`
- Modify: `tests/pending-store.test.ts`

**Interfaces:**
- Consumes: existing private `patch(id, fields)`, the open-time cursor pattern.
- Produces, added to `PendingStore`:
  - `setImportance(id: string, importance: Importance): Promise<void>`
  - `setDeadline(id: string, deadline_at: number | null): Promise<void>`

- [ ] **Step 1: Write failing tests** — append inside the `describe` in `tests/pending-store.test.ts`

```ts
  it("setImportance sets the tier and marks unsynced", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a", importance: "normal", synced: true }));
    await store.setImportance("a", "high");
    const r = await store.getByCanonicalUrl("u-a");
    expect(r?.importance).toBe("high");
    expect(r?.synced).toBe(false);
  });

  it("setDeadline sets and clears the deadline, marking unsynced", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a", synced: true }));
    await store.setDeadline("a", 1234);
    expect((await store.getByCanonicalUrl("u-a"))?.deadline_at).toBe(1234);
    await store.setDeadline("a", null);
    const r = await store.getByCanonicalUrl("u-a");
    expect(r?.deadline_at == null).toBe(true);
    expect(r?.synced).toBe(false);
  });

  it("migrates a legacy matters record to high on store open", async () => {
    // Seed a legacy record directly via put with a raw matters value, marked synced.
    const seed = await createPendingStore();
    await seed.put(rec({ id: "leg", canonical_url: "u-leg", importance: "matters" as never, synced: true }));
    // Re-open: the open-time migration should rewrite matters -> high (and unsync it).
    const reopened = await createPendingStore();
    const r = await reopened.getByCanonicalUrl("u-leg");
    expect(r?.importance).toBe("high");
    expect(r?.synced).toBe(false);
  });
```

(Confirm the test file already has a `rec(...)` helper and `createPendingStore` import — it does, from PRD 05a. If `rec` does not accept `importance`/`deadline_at`, they pass through `...over` onto the `PendingCapture`, which now allows them.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/pending-store.test.ts`
Expected: FAIL — `setImportance`/`setDeadline` not functions; the legacy record stays `matters`.

- [ ] **Step 3: Edit `src/pending-store.ts`**

Add to the `PendingStore` interface (after `move`/`listByCollection`):

```ts
  setImportance(id: string, importance: Importance): Promise<void>;
  setDeadline(id: string, deadline_at: number | null): Promise<void>;
```

Import `Importance`:

```ts
import type { CaptureStatus, Importance, PendingCapture } from "./types";
```

Retype the legacy `tag()` importance param in the interface (it has no callers; keep it type-correct):

```ts
  tag(id: string, opts: { topic_tags: string[]; importance?: Importance }): Promise<void>;
```

Add the open-time `matters→high` migration alongside the existing `user_id` backfill (after `userId` is resolved). It is idempotent — re-running finds no `matters` rows:

```ts
  // PRD 06a: rewrite any legacy "matters" importance to "high" (device-owned;
  // unsync so the corrected value propagates). Idempotent.
  {
    const tx = db.transaction(PENDING_STORE, "readwrite");
    let cursor = await tx.store.openCursor();
    while (cursor) {
      const r = cursor.value as PendingCapture;
      if ((r.importance as unknown) === "matters") {
        await cursor.update({ ...r, importance: "high", synced: false });
      }
      cursor = await cursor.continue();
    }
    await tx.done;
  }
```

In the returned object, add the two setters (after `move`):

```ts
    async setImportance(id, importance) {
      await patch(id, { importance });
    },
    async setDeadline(id, deadline_at) {
      await patch(id, { deadline_at: deadline_at ?? undefined });
    },
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/pending-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix any broken `PendingStore` mock literals**

Adding two interface methods breaks object-literal mocks that must satisfy `PendingStore`. Search and extend them:

Run: `npx tsc --noEmit`
For each error of the form "Type '{ … }' is missing properties from 'PendingStore': setImportance, setDeadline", add to that mock:

```ts
    async setImportance() {},
    async setDeadline() {},
```

Known mock sites from PRD 05a/03: `tests/sync.test.ts`, `tests/capture.test.ts`, `tests/import/promote.test.ts`. Fix exactly the ones tsc flags.

- [ ] **Step 6: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all green.

- [ ] **Step 7: Commit**

```bash
git add src/pending-store.ts tests/
git commit -m "feat(prd06a): pending-store setImportance/setDeadline + matters→high open migration"
```

---

### Task 5: Sync `deadline_at` + pull-safety (worker UPSERT, row-to-pending, mergePulled)

**Files:**
- Modify: `worker/index.ts` (`WireRecord`, `UPSERT_SQL`, `toBind`)
- Modify: `src/reminder/row-to-pending.ts`
- Modify: `tests/worker-sync.test.ts`
- Modify: `tests/reminder/row-to-pending.test.ts`
- Modify: `tests/reminder/reconcile-pull.test.ts`

**Interfaces:**
- Consumes: existing `WireRecord`/`UPSERT_SQL`/`toBind`; `rowToPending`; `mergePulled`; `normalizeImportance`.
- Produces: `deadline_at` becomes the final bound column `[18]` (appended after `collection_id` at `[17]`, so `[0]..[17]` are unchanged); `rowToPending` maps `deadline_at` and normalizes `importance`.

- [ ] **Step 1: Write failing tests**

Append to `tests/worker-sync.test.ts` (inside its describe):

```ts
  it("carries deadline_at as a device-owned content column", () => {
    expect(UPSERT_SQL).toContain("deadline_at = excluded.deadline_at");
    expect(toBind(wire({ deadline_at: 1717 }))[18]).toBe(1717);
  });
  it("binds null when deadline_at is absent", () => {
    expect(toBind(wire())[18]).toBeNull();
  });
```

Append to `tests/reminder/row-to-pending.test.ts`:

```ts
  it("maps deadline_at and normalizes a legacy matters importance to high", () => {
    const p = rowToPending({ id: "a", canonical_url: "u", raw_payload: "{}", captured_at: 1, source: "import", status: "tagged", parse_ok: 1, importance: "matters", deadline_at: 4242 });
    expect(p.deadline_at).toBe(4242);
    expect(p.importance).toBe("high");
  });
  it("leaves deadline_at undefined when the column is null", () => {
    const p = rowToPending({ id: "a", canonical_url: "u", raw_payload: "{}", captured_at: 1, source: "import", status: "tagged", parse_ok: 1, deadline_at: null });
    expect(p.deadline_at).toBeUndefined();
  });
```

Append to `tests/reminder/reconcile-pull.test.ts`:

```ts
  it("does not clobber a newer local deadline_at on pull", () => {
    const local = rec({ deadline_at: 8888, reminder_status: "active", synced: false });
    const remote = rec({ deadline_at: 1111, reminder_status: "expired", next_due_at: 99 });
    const merged = mergePulled(local, remote);
    expect(merged.deadline_at).toBe(8888); // device-owned content kept
    expect(merged.reminder_status).toBe("expired"); // server-owned overlaid
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/worker-sync.test.ts tests/reminder/row-to-pending.test.ts tests/reminder/reconcile-pull.test.ts`
Expected: FAIL — `UPSERT_SQL` lacks `deadline_at`; `toBind(...)[18]` is `undefined`; `rowToPending` lacks `deadline_at` and returns `matters`.

- [ ] **Step 3: Edit `worker/index.ts`**

In `WireRecord`, after `collection_id?: string;`:

```ts
  collection_id?: string;
  deadline_at?: number;
```

In `UPSERT_SQL`: append `deadline_at` to the INSERT column list, add one `?` to `VALUES`, and add the `ON CONFLICT … DO UPDATE SET` line:

```ts
    user_id, collection_id, deadline_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(id) DO UPDATE SET
   …
   collection_id = excluded.collection_id,
   deadline_at = excluded.deadline_at`;
```

In `toBind`, append after `r.collection_id ?? null,`:

```ts
    r.collection_id ?? null,
    r.deadline_at ?? null,
  ];
```

- [ ] **Step 4: Edit `src/reminder/row-to-pending.ts`**

Add the import:

```ts
import { normalizeImportance } from "./spacing";
```

Change the `importance` mapping and add `deadline_at` (after `tagged_at`/`collection_id`):

```ts
    importance: normalizeImportance(row.importance),
    tagged_at: num(row.tagged_at),
    collection_id: str(row.collection_id),
    deadline_at: num(row.deadline_at),
```

(The previous line was `importance: str(row.importance) as Importance | undefined,` — replace it. `normalizeImportance` returns a concrete `Importance`, never undefined; that is correct — a pulled row with no importance becomes `normal`.)

This changes one existing assertion: `tests/reminder/row-to-pending.test.ts` has a "normalizes nulls" test that does `expect(p.importance).toBeUndefined()` for a row with `importance: null`. Update it to the new behaviour:

```ts
    expect(p.importance).toBe("normal"); // was toBeUndefined(); null now normalizes to "normal"
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run tests/worker-sync.test.ts tests/reminder/row-to-pending.test.ts tests/reminder/reconcile-pull.test.ts`
Expected: PASS — including the unchanged `[11]..[17]` index assertions (deadline_at appended after).

- [ ] **Step 6: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all green.

- [ ] **Step 7: Commit**

```bash
git add worker/index.ts src/reminder/row-to-pending.ts tests/
git commit -m "feat(prd06a): sync deadline_at; map deadline + normalize importance on pull"
```

---

### Task 6: D1 schema + migration docs

**Files:**
- Modify: `schema.sql`
- Modify: `docs/manual-verification.md`

No vitest coverage (D1 DDL isn't exercised headlessly). Verify by applying to a local D1.

- [ ] **Step 1: Edit `schema.sql`**

Add `deadline_at TEXT`/`INTEGER` to the `pending_capture` `CREATE TABLE`, immediately after the `collection_id    TEXT` line (before the closing `);`):

```sql
  collection_id    TEXT,
  deadline_at      INTEGER
);
```

- [ ] **Step 2: Verify the schema applies to a local D1**

Run: `npx wrangler d1 execute insave --local --file=./schema.sql --yes`
Expected: "Executed N commands" with no SQL error. (If `--yes` is unrecognised on the pinned wrangler, rerun without it.)

- [ ] **Step 3: Document the remote migration** — append to `docs/manual-verification.md` under the migration section, a "PRD 06a" subsection

```markdown
### PRD 06a — Importance tiers + deadlines (remote D1 migration)

Apply once against the deployed DB (existing rows untouched; `deadline_at` null ≡ no deadline):

    npx wrangler d1 execute insave --remote --command \
      "ALTER TABLE pending_capture ADD COLUMN deadline_at INTEGER;"
    npx wrangler d1 execute insave --remote --command \
      "UPDATE pending_capture SET importance = 'high' WHERE importance = 'matters';"

Ordering: run this BEFORE deploying the 06a worker (the cron/sync read `deadline_at`). The
`matters→high` UPDATE is a one-time value remap; the client also coerces `matters→high` at read time
(`normalizeImportance`) and rewrites local IndexedDB on open, so the system is correct even before the
remote UPDATE runs — but run it so D1 values are clean.

### Checklist (PRD 06a)
- [ ] After migration, an item with `importance='high'` resurfaces sooner/persists longer than
      `normal`; `low` is wide and ages out fast.
- [ ] A pre-existing `matters` row reads as `high` after pull and after the local open-time migration.
- [ ] Setting a future `deadline_at` keeps the item quiet until the deadline, then it surfaces; a
      snooze afterwards resumes tier spacing; reminder-state columns are never written by the device.
```

- [ ] **Step 4: Commit**

```bash
git add schema.sql docs/manual-verification.md
git commit -m "chore(prd06a): D1 deadline_at column + importance/deadline migration docs"
```

---

## Final verification (after all tasks)

- [ ] `npx tsc --noEmit` — clean.
- [ ] `npx vitest run` — all green (151 baseline + new: normalize/tier (~6), deadline (~6), digest/cron (~3), pending-store (~3), sync/pull (~5) ≈ 174).
- [ ] `npx vite build` — production build succeeds.
- [ ] Spec acceptance (§7) re-read against the diff; UI-dependent ACs (3-tier control, deadline picker, review-view rank) explicitly deferred to 06b.
- [ ] Disjoint ownership intact: the device writes only `importance`/`deadline_at` (`synced=false`); `next_due_at` and the other reminder-state columns are written only by the cron.

## Spec coverage map

| Spec §7 acceptance | Task |
|---|---|
| 3-tier importance, default normal | 1 |
| Perceptibly different per-tier schedules | 1 (3 presets), 2 |
| `matters→high`, nulls→normal migration | 1 (normalize), 4 (local rewrite), 6 (remote UPDATE) |
| `deadline_at` field + future-deadline override | 1 (field), 2 (engine), 3 (cron/digest) |
| Post-deadline / snooze reverts to tier spacing | 2 (override inert past deadline; snooze unchanged) |
| Device-owned; no reminder-state clobber | 4 (setters synced=false), 5 (sync + mergePulled regression) |
| Cron idempotency / quiet hours / back-off intact | 3 (unchanged paths; cron tests stay green) |
