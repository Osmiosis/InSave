# PRD 04a — Reminder Engine Core (headless) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the headless scheduling brain of the Reminder Engine — a Cloudflare Cron Worker that reads D1, advances tracked reels along an importance-keyed spaced-repetition curve, and assembles a capped, quiet-hours-respecting digest per user, with the actual push send stubbed.

**Architecture:** Pure logic modules in `src/reminder/` (spacing curve, response transitions, digest selection) are composed by a `runCron` orchestrator in `worker/cron.ts` that talks to D1 through an injectable `ReminderRepo` port. Tests drive the pure modules directly and the cron against an in-memory fake repo; the D1-backed repo and the `scheduled` handler are thin adapters verified by `tsc` + manual checklist. Reminder-state columns are cron-owned; the device sync path writes a disjoint column set, so no reconciliation arbitration is needed.

**Tech Stack:** TypeScript, Cloudflare Worker (`scheduled` + `fetch`) + D1, Cron Triggers, `idb` (IndexedDB v4), vitest + fake-indexeddb.

## Global Constraints

- No new runtime dependencies.
- Reminder-state columns (`reminder_status`, `next_due_at`, `cycle_count`, `ignored_count`, `last_surfaced_at`) are written ONLY by the cron path. The device `/api/sync` upsert must never set or update them.
- All tuning constants live in one place per module (`PRESETS`, `IGNORE_THRESHOLD`, `IGNORE_ACCEL`, `DIGEST_CAP`, `CADENCE_GAP`) — they are sane defaults, expected to change.
- Injectable clock: every function that needs "now" takes it as a `number` (epoch ms) parameter; no `Date.now()` inside pure modules. The Worker entry supplies `Date.now()`.
- Spacing presets (verbatim): `matters` = initialDelay 1 day, growth ×1.6, maxCycles 8, maxAge 90 days. `normal` = initialDelay 3 days, growth ×2.0, maxCycles 4, maxAge 45 days. `IGNORE_THRESHOLD` = 2, `IGNORE_ACCEL` = ×1.5. `DIGEST_CAP` = 5. Cadence min-gaps: often 1 day, balanced 2 days, rarely 4 days. Quiet-hours default 22→08. Cron `0 * * * *` (hourly).
- Tests live in `tests/`, mirroring `src/`/`worker/` paths. Run `npx vitest run`; type-check + build `npm run build` (`tsc && vite build`).
- `DAY = 86_400_000` ms.

---

### Task 1: Reminder types + spacing curve

**Files:**
- Modify: `src/types.ts`
- Create: `src/reminder/spacing.ts`
- Test: `tests/reminder/spacing.test.ts`

**Interfaces:**
- Consumes: existing `PendingCapture`.
- Produces: `ReminderStatus`, `Importance`, `Cadence` type aliases; `PendingCapture` gains `user_id?`, `reminder_status?`, `next_due_at?`, `cycle_count?`, `ignored_count?`, `last_surfaced_at?`; `UserSettings` interface. `spacing.ts` exports `PRESETS`, `IGNORE_THRESHOLD`, `IGNORE_ACCEL`, `DAY`, `presetFor(importance)`, `ReminderState`, `initialState(importance, now): ReminderState`, `advance(item, now): { reminder_status; next_due_at; cycle_count; last_surfaced_at }`.

- [ ] **Step 1: Add the types in `src/types.ts`**

Change the `importance` line inside `PendingCapture` from:

```ts
  importance?: "normal" | "matters";
```

to:

```ts
  importance?: Importance;
```

Add the new optional fields to `PendingCapture` immediately after the `media_type?` line:

```ts
  // Reminder engine (PRD 04). Server-owned (cron is the sole writer); absent until tagged.
  user_id?: string;
  reminder_status?: ReminderStatus;
  next_due_at?: number;
  cycle_count?: number;
  ignored_count?: number;
  last_surfaced_at?: number;
```

Add these type declarations near the top of the file, just after the `CaptureStatus` line:

```ts
export type ReminderStatus = "active" | "snoozed" | "done" | "expired";
export type Importance = "normal" | "matters";
export type Cadence = "often" | "balanced" | "rarely";
```

Add the `UserSettings` interface at the end of the file, before the final `export type { PendingStore }` line:

```ts
export interface UserSettings {
  user_id: string;
  quiet_start: number;   // local hour 0-23
  quiet_end: number;     // local hour 0-23
  timezone: string;      // IANA tz
  cadence: Cadence;
  reminders_paused: boolean;
  last_digest_at?: number;
  synced: boolean;       // local-only
}
```

- [ ] **Step 2: Write the failing spacing test**

Create `tests/reminder/spacing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { initialState, advance, PRESETS, DAY } from "../../src/reminder/spacing";
import type { PendingCapture } from "../../src/types";

function item(over: Partial<PendingCapture> = {}): PendingCapture {
  return {
    id: "i", canonical_url: "u", raw_payload: "{}", captured_at: 0,
    source: "import", status: "tagged", parse_ok: true, synced: true,
    importance: "normal", tagged_at: 0, cycle_count: 0, ignored_count: 0,
    reminder_status: "active", ...over,
  };
}

describe("spacing.initialState", () => {
  it("seeds an active item due after the importance initial delay", () => {
    expect(initialState("matters", 1000)).toEqual({
      reminder_status: "active", cycle_count: 0, ignored_count: 0,
      next_due_at: 1000 + PRESETS.matters.initialDelay,
    });
  });
  it("defaults undefined importance to normal", () => {
    expect(initialState(undefined, 0).next_due_at).toBe(PRESETS.normal.initialDelay);
  });
});

describe("spacing.advance", () => {
  it("widens the interval each cycle and bumps cycle_count", () => {
    const a0 = advance(item({ cycle_count: 0 }), 0);
    expect(a0.cycle_count).toBe(1);
    expect(a0.next_due_at).toBe(PRESETS.normal.initialDelay); // 3d * 2^0
    const a1 = advance(item({ cycle_count: 1 }), 0);
    expect(a1.next_due_at).toBe(PRESETS.normal.initialDelay * 2); // 3d * 2^1
  });

  it("matters resurfaces sooner than normal at the same cycle", () => {
    const m = advance(item({ importance: "matters", cycle_count: 0 }), 0).next_due_at;
    const n = advance(item({ importance: "normal", cycle_count: 0 }), 0).next_due_at;
    expect(m).toBeLessThan(n);
  });

  it("expires past maxCycles", () => {
    const a = advance(item({ importance: "normal", cycle_count: 4 }), 0); // 4 -> 5 > maxCycles 4
    expect(a.reminder_status).toBe("expired");
  });

  it("expires past maxAge even below maxCycles", () => {
    const old = item({ importance: "matters", cycle_count: 1, tagged_at: 0 });
    const a = advance(old, PRESETS.matters.maxAge + DAY);
    expect(a.reminder_status).toBe("expired");
  });

  it("records last_surfaced_at = now", () => {
    expect(advance(item(), 5555).last_surfaced_at).toBe(5555);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/reminder/spacing.test.ts`
Expected: FAIL — cannot find module `../../src/reminder/spacing`.

- [ ] **Step 4: Implement `src/reminder/spacing.ts`**

```ts
import type { Importance, PendingCapture, ReminderStatus } from "../types";

export const DAY = 86_400_000;

export interface Preset {
  initialDelay: number;
  growth: number;
  maxCycles: number;
  maxAge: number;
}

// Tuning values (PRD 04 §10) — expect to adjust against a real backlog.
export const PRESETS: Record<Importance, Preset> = {
  matters: { initialDelay: 1 * DAY, growth: 1.6, maxCycles: 8, maxAge: 90 * DAY },
  normal: { initialDelay: 3 * DAY, growth: 2.0, maxCycles: 4, maxAge: 45 * DAY },
};

export const IGNORE_THRESHOLD = 2;
export const IGNORE_ACCEL = 1.5;

export function presetFor(importance: Importance | undefined): Preset {
  return PRESETS[importance ?? "normal"];
}

export interface ReminderState {
  reminder_status: ReminderStatus;
  next_due_at: number;
  cycle_count: number;
  ignored_count: number;
}

export function initialState(importance: Importance | undefined, now: number): ReminderState {
  return {
    reminder_status: "active",
    cycle_count: 0,
    ignored_count: 0,
    next_due_at: now + presetFor(importance).initialDelay,
  };
}

// The "surfaced, not yet acted upon" scheduling transition. Reads ignored_count to
// decide whether back-off acceleration applies; does NOT itself change ignored_count
// (that is markIgnored's job — see response.ts — composed by the cron).
export function advance(
  item: PendingCapture,
  now: number,
): { reminder_status: ReminderStatus; next_due_at: number; cycle_count: number; last_surfaced_at: number } {
  const p = presetFor(item.importance);
  const cycle = item.cycle_count ?? 0;
  const accel = (item.ignored_count ?? 0) >= IGNORE_THRESHOLD ? IGNORE_ACCEL : 1;
  const interval = p.initialDelay * Math.pow(p.growth * accel, cycle);
  const nextCycle = cycle + 1;
  const loopEntry = item.tagged_at ?? item.captured_at;
  const ageHorizon = accel > 1 ? p.maxAge / 2 : p.maxAge; // ignore back-off lowers the horizon
  const expired = nextCycle > p.maxCycles || now - loopEntry > ageHorizon;
  return {
    reminder_status: expired ? "expired" : "active",
    next_due_at: now + interval,
    cycle_count: nextCycle,
    last_surfaced_at: now,
  };
}
```

- [ ] **Step 5: Run the test + type-check**

Run: `npx vitest run tests/reminder/spacing.test.ts` then `npx tsc --noEmit`
Expected: PASS (7 tests); no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/reminder/spacing.ts tests/reminder/spacing.test.ts
git commit -m "feat: reminder types + spacing curve (PRD 04a)"
```

---

### Task 2: Response transitions

**Files:**
- Create: `src/reminder/response.ts`
- Test: `tests/reminder/response.test.ts`

**Interfaces:**
- Consumes: `PendingCapture`, `Importance` (Task 1); `presetFor` (Task 1).
- Produces: `markDone(item): { reminder_status }`, `snooze(item, now): { next_due_at; reminder_status }`, `markOpened(item): { ignored_count }`, `markIgnored(item): { ignored_count }`. (Pure field patches; the cron and 04b apply them.)

- [ ] **Step 1: Write the failing response test**

Create `tests/reminder/response.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { markDone, snooze, markOpened, markIgnored } from "../../src/reminder/response";
import { presetFor } from "../../src/reminder/spacing";
import type { PendingCapture } from "../../src/types";

function item(over: Partial<PendingCapture> = {}): PendingCapture {
  return {
    id: "i", canonical_url: "u", raw_payload: "{}", captured_at: 0,
    source: "import", status: "tagged", parse_ok: true, synced: true,
    importance: "normal", reminder_status: "active", cycle_count: 1, ignored_count: 2, ...over,
  };
}

describe("response", () => {
  it("markDone retires the item", () => {
    expect(markDone(item())).toEqual({ reminder_status: "done" });
  });

  it("snooze defers one base interval, stays active, no ignore penalty", () => {
    const r = snooze(item({ importance: "matters" }), 1000);
    expect(r.reminder_status).toBe("active");
    expect(r.next_due_at).toBe(1000 + presetFor("matters").initialDelay);
    expect(r).not.toHaveProperty("ignored_count");
  });

  it("markOpened resets ignored_count to 0", () => {
    expect(markOpened(item({ ignored_count: 5 }))).toEqual({ ignored_count: 0 });
  });

  it("markIgnored increments ignored_count", () => {
    expect(markIgnored(item({ ignored_count: 2 }))).toEqual({ ignored_count: 3 });
    expect(markIgnored(item({ ignored_count: undefined }))).toEqual({ ignored_count: 1 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/reminder/response.test.ts`
Expected: FAIL — cannot find module `../../src/reminder/response`.

- [ ] **Step 3: Implement `src/reminder/response.ts`**

```ts
import type { PendingCapture, ReminderStatus } from "../types";
import { presetFor } from "./spacing";

// User-action transitions. Pure field patches; the cron (and PRD 04b's review UI)
// merge the returned fields onto the item.

export function markDone(_item: PendingCapture): { reminder_status: ReminderStatus } {
  return { reminder_status: "done" };
}

export function snooze(
  item: PendingCapture,
  now: number,
): { next_due_at: number; reminder_status: ReminderStatus } {
  return { reminder_status: "active", next_due_at: now + presetFor(item.importance).initialDelay };
}

export function markOpened(_item: PendingCapture): { ignored_count: number } {
  return { ignored_count: 0 };
}

export function markIgnored(item: PendingCapture): { ignored_count: number } {
  return { ignored_count: (item.ignored_count ?? 0) + 1 };
}
```

- [ ] **Step 4: Run the test + type-check**

Run: `npx vitest run tests/reminder/response.test.ts` then `npx tsc --noEmit`
Expected: PASS (4 tests); no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/reminder/response.ts tests/reminder/response.test.ts
git commit -m "feat: reminder response transitions (PRD 04a)"
```

---

### Task 3: Digest selection + gating

**Files:**
- Create: `src/reminder/digest.ts`
- Test: `tests/reminder/digest.test.ts`

**Interfaces:**
- Consumes: `PendingCapture`, `UserSettings` (Task 1).
- Produces: `DIGEST_CAP`, `CADENCE_GAP`, `selectDue(items, settings, now): PendingCapture[]`, `localHour(tz, now): number`, `isQuietHours(settings, now): boolean`, `cadenceGate(settings, now, hasMatters): boolean`.

- [ ] **Step 1: Write the failing digest test**

Create `tests/reminder/digest.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { selectDue, isQuietHours, cadenceGate, DIGEST_CAP, CADENCE_GAP } from "../../src/reminder/digest";
import { DAY } from "../../src/reminder/spacing";
import type { PendingCapture, UserSettings } from "../../src/types";

function item(over: Partial<PendingCapture>): PendingCapture {
  return {
    id: "i", canonical_url: "u", raw_payload: "{}", captured_at: 0,
    source: "import", status: "tagged", parse_ok: true, synced: true,
    reminder_status: "active", importance: "normal", next_due_at: 0, ...over,
  };
}

function settings(over: Partial<UserSettings> = {}): UserSettings {
  return {
    user_id: "u1", quiet_start: 0, quiet_end: 0, timezone: "UTC",
    cadence: "balanced", reminders_paused: false, synced: true, ...over,
  };
}

describe("selectDue", () => {
  it("keeps active items whose next_due_at has passed", () => {
    const due = selectDue(
      [item({ id: "a", next_due_at: 100 }), item({ id: "b", next_due_at: 5000 })],
      settings(), 1000,
    );
    expect(due.map((i) => i.id)).toEqual(["a"]);
  });

  it("orders matters before normal, then most-overdue first", () => {
    const due = selectDue([
      item({ id: "n1", importance: "normal", next_due_at: 10 }),
      item({ id: "m1", importance: "matters", next_due_at: 900 }),
      item({ id: "m2", importance: "matters", next_due_at: 100 }),
    ], settings(), 1000);
    expect(due.map((i) => i.id)).toEqual(["m2", "m1", "n1"]);
  });

  it("excludes non-active items", () => {
    const due = selectDue([item({ id: "x", reminder_status: "done", next_due_at: 0 })], settings(), 1000);
    expect(due).toEqual([]);
  });

  it("returns nothing when reminders are paused", () => {
    const due = selectDue([item({ id: "a", next_due_at: 0 })], settings({ reminders_paused: true }), 1000);
    expect(due).toEqual([]);
  });

  it("caps the digest", () => {
    const many = Array.from({ length: DIGEST_CAP + 3 }, (_, i) => item({ id: `i${i}`, next_due_at: i }));
    expect(selectDue(many, settings(), 1_000_000)).toHaveLength(DIGEST_CAP);
  });
});

describe("isQuietHours", () => {
  it("never quiet when start == end (00..00)", () => {
    expect(isQuietHours(settings({ quiet_start: 0, quiet_end: 0 }), 0)).toBe(false);
  });
  it("handles a midnight-wrapping window (22..8 UTC, 02:00 is quiet)", () => {
    const t = Date.UTC(2026, 0, 1, 2, 0, 0); // 02:00 UTC
    expect(isQuietHours(settings({ quiet_start: 22, quiet_end: 8, timezone: "UTC" }), t)).toBe(true);
  });
  it("midday is not quiet under 22..8", () => {
    const t = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(isQuietHours(settings({ quiet_start: 22, quiet_end: 8, timezone: "UTC" }), t)).toBe(false);
  });
});

describe("cadenceGate", () => {
  it("allows when no prior digest", () => {
    expect(cadenceGate(settings(), 1000, false)).toBe(true);
  });
  it("blocks within the balanced min-gap", () => {
    expect(cadenceGate(settings({ last_digest_at: 0 }), CADENCE_GAP.balanced - 1, false)).toBe(false);
  });
  it("a matters item pulls the gap forward to the often interval", () => {
    const now = CADENCE_GAP.often + 1;
    expect(cadenceGate(settings({ last_digest_at: 0 }), now, false)).toBe(false);
    expect(cadenceGate(settings({ last_digest_at: 0 }), now, true)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/reminder/digest.test.ts`
Expected: FAIL — cannot find module `../../src/reminder/digest`.

- [ ] **Step 3: Implement `src/reminder/digest.ts`**

```ts
import type { PendingCapture, UserSettings } from "../types";
import { DAY } from "./spacing";

export const DIGEST_CAP = 5;
export const CADENCE_GAP: Record<UserSettings["cadence"], number> = {
  often: 1 * DAY,
  balanced: 2 * DAY,
  rarely: 4 * DAY,
};

export function selectDue(
  items: PendingCapture[],
  settings: UserSettings,
  now: number,
): PendingCapture[] {
  if (settings.reminders_paused) return [];
  const rank = (i: PendingCapture) => (i.importance === "matters" ? 0 : 1);
  return items
    .filter((i) => i.reminder_status === "active" && (i.next_due_at ?? Infinity) <= now)
    .sort((a, b) => rank(a) - rank(b) || (a.next_due_at ?? 0) - (b.next_due_at ?? 0))
    .slice(0, DIGEST_CAP);
}

export function localHour(tz: string, now: number): number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false });
  return Number(f.format(new Date(now))) % 24;
}

export function isQuietHours(settings: UserSettings, now: number): boolean {
  const h = localHour(settings.timezone, now);
  const { quiet_start: a, quiet_end: b } = settings;
  return a <= b ? h >= a && h < b : h >= a || h < b;
}

export function cadenceGate(settings: UserSettings, now: number, hasMatters: boolean): boolean {
  if (settings.last_digest_at == null) return true;
  const gap = hasMatters ? CADENCE_GAP.often : CADENCE_GAP[settings.cadence];
  return now - settings.last_digest_at >= gap;
}
```

- [ ] **Step 4: Run the test + type-check**

Run: `npx vitest run tests/reminder/digest.test.ts` then `npx tsc --noEmit`
Expected: PASS (11 tests); no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/reminder/digest.ts tests/reminder/digest.test.ts
git commit -m "feat: digest selection + quiet-hours/cadence gating (PRD 04a)"
```

---

### Task 4: D1 schema + IndexedDB v4 + device identity stamping

**Files:**
- Modify: `schema.sql`
- Modify: `src/db.ts`
- Modify: `src/pending-store.ts`
- Test: `tests/db.test.ts` (add a v4 case)
- Test: `tests/pending-store.test.ts` (add an identity case)

**Interfaces:**
- Consumes: `UserSettings`, reminder fields (Task 1).
- Produces: D1 columns + `user_settings` table + `idx_due`; IndexedDB v4 with `user_settings` + `meta` stores; `createPendingStore(now?, uuid?)` now stamps `user_id` (minted once into `meta`) on every write and backfills pre-existing records.

- [ ] **Step 1: Add the D1 columns + settings table in `schema.sql`**

After the `media_type TEXT` column line inside `CREATE TABLE pending_capture (...)`, add (keep the closing `)` and the `idx_canonical_url` index that follow):

```sql
  ,
  user_id          TEXT,
  reminder_status  TEXT,
  next_due_at      INTEGER,
  cycle_count      INTEGER,
  ignored_count    INTEGER,
  last_surfaced_at INTEGER
```

At the end of the file add:

```sql
CREATE TABLE IF NOT EXISTS user_settings (
  user_id          TEXT PRIMARY KEY,
  quiet_start      INTEGER,
  quiet_end        INTEGER,
  timezone         TEXT,
  cadence          TEXT,
  reminders_paused INTEGER,
  last_digest_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_due
  ON pending_capture (user_id, reminder_status, next_due_at);
```

- [ ] **Step 2: Bump IndexedDB to v4 in `src/db.ts`**

Add two store-name constants after the existing `IMPORTED_STORE` line:

```ts
export const USER_SETTINGS_STORE = "user_settings";
export const META_STORE = "meta";
```

Change `openDB(DB_NAME, 3, {` to `openDB(DB_NAME, 4, {` and add this block inside `upgrade`, after the `if (oldVersion < 3)` block:

```ts
      if (oldVersion < 4) {
        database.createObjectStore(USER_SETTINGS_STORE, { keyPath: "user_id" });
        database.createObjectStore(META_STORE, { keyPath: "key" });
      }
```

- [ ] **Step 3: Write the failing db v4 test**

Add this case inside the `describe("db schema", ...)` block in `tests/db.test.ts` (before its closing `});`):

```ts
  it("opens at version 4 with user_settings and meta stores", async () => {
    const db = await openInsaveDB();
    expect(db.version).toBe(4);
    expect([...db.objectStoreNames]).toContain("user_settings");
    expect([...db.objectStoreNames]).toContain("meta");
  });
```

- [ ] **Step 4: Write the failing identity test**

Add this case inside the `describe("pending-store", ...)` block in `tests/pending-store.test.ts` (before its closing `});`):

```ts
  it("stamps a minted user_id onto writes and persists it in meta", async () => {
    const store = await createPendingStore(() => 0, () => "user-xyz");
    await store.put(rec({ id: "a", canonical_url: "u-a" }));
    const r = await store.getByCanonicalUrl("u-a");
    expect(r?.user_id).toBe("user-xyz");
  });

  it("does not overwrite an existing user_id on a record", async () => {
    const store = await createPendingStore(() => 0, () => "user-xyz");
    await store.put(rec({ id: "b", canonical_url: "u-b", user_id: "other" }));
    expect((await store.getByCanonicalUrl("u-b"))?.user_id).toBe("other");
  });
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx vitest run tests/db.test.ts tests/pending-store.test.ts`
Expected: FAIL — v4 store assertions fail and `createPendingStore` ignores the 2nd (uuid) arg / does not stamp `user_id`.

- [ ] **Step 6: Add identity stamping in `src/pending-store.ts`**

Change the imports line to include the meta store:

```ts
import { openInsaveDB, PENDING_STORE, META_STORE } from "./db";
```

Replace the `createPendingStore` signature + the start of its body (down to and including `const db = await openInsaveDB();`) with:

```ts
export async function createPendingStore(
  now: () => number = () => Date.now(),
  uuid: () => string = () => crypto.randomUUID(),
): Promise<PendingStore> {
  const db = await openInsaveDB();

  // Mint (once) and read the device's own user_id; backfill any pre-existing records.
  let meta = (await db.get(META_STORE, "user_id")) as { key: string; value: string } | undefined;
  if (!meta) {
    meta = { key: "user_id", value: uuid() };
    await db.put(META_STORE, meta);
    const tx = db.transaction(PENDING_STORE, "readwrite");
    let cursor = await tx.store.openCursor();
    while (cursor) {
      const r = cursor.value as PendingCapture;
      if (!r.user_id) await cursor.update({ ...r, user_id: meta.value, synced: false });
      cursor = await cursor.continue();
    }
    await tx.done;
  }
  const userId = meta.value;
```

In the same file, replace the `put` method body and the `patch` helper to stamp `user_id`:

```ts
    async put(record) {
      await db.put(PENDING_STORE, { ...record, user_id: record.user_id ?? userId });
    },
```

and change `patch` to:

```ts
  async function patch(id: string, fields: Partial<PendingCapture>): Promise<void> {
    const tx = db.transaction(PENDING_STORE, "readwrite");
    const r = (await tx.store.get(id)) as PendingCapture | undefined;
    if (r) await tx.store.put({ ...r, ...fields, user_id: r.user_id ?? userId, synced: false });
    await tx.done;
  }
```

- [ ] **Step 7: Run the tests + type-check**

Run: `npx vitest run` then `npx tsc --noEmit`
Expected: all pass; no type errors. (`crypto.randomUUID` is available in the vitest/node and Worker runtimes; tests inject the uuid fn so they don't depend on it.)

- [ ] **Step 8: Commit**

```bash
git add schema.sql src/db.ts src/pending-store.ts tests/db.test.ts tests/pending-store.test.ts
git commit -m "feat: D1 reminder columns + settings table, IDB v4, device user_id stamping (PRD 04a)"
```

---

### Task 5: ReminderRepo port + cron orchestration

**Files:**
- Create: `worker/reminder-repo.ts`
- Create: `worker/cron.ts`
- Test: `tests/reminder/cron.test.ts`

**Interfaces:**
- Consumes: `PendingCapture`, `UserSettings` (Task 1); `initialState`, `advance` (Task 1); `markIgnored` (Task 2); `selectDue`, `isQuietHours`, `cadenceGate` (Task 3).
- Produces: `ReminderRepo` interface (`listTagged()`, `getSettings(userId)`, `putSettings(s)`, `writeReminderState(id, fields)`); `defaultSettings(userId, timezone?): UserSettings`; `Notify` type; `runCron(repo, now, notify): Promise<void>`.

- [ ] **Step 1: Define the repo port in `worker/reminder-repo.ts`**

```ts
import type { PendingCapture, UserSettings } from "../src/types";

export interface ReminderRepo {
  listTagged(): Promise<PendingCapture[]>;
  getSettings(userId: string): Promise<UserSettings | undefined>;
  putSettings(settings: UserSettings): Promise<void>;
  writeReminderState(id: string, fields: Partial<PendingCapture>): Promise<void>;
}

export function defaultSettings(userId: string, timezone = "UTC"): UserSettings {
  return {
    user_id: userId,
    quiet_start: 22,
    quiet_end: 8,
    timezone,
    cadence: "balanced",
    reminders_paused: false,
    synced: true,
  };
}
```

- [ ] **Step 2: Write the failing cron test**

Create `tests/reminder/cron.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runCron } from "../../worker/cron";
import { defaultSettings, type ReminderRepo } from "../../worker/reminder-repo";
import { PRESETS, DAY } from "../../src/reminder/spacing";
import type { PendingCapture, UserSettings } from "../../src/types";

function item(over: Partial<PendingCapture>): PendingCapture {
  return {
    id: "i", canonical_url: "u", raw_payload: "{}", captured_at: 0,
    source: "import", status: "tagged", parse_ok: true, synced: true,
    user_id: "u1", importance: "normal", tagged_at: 0, ...over,
  };
}

function fakeRepo(items: PendingCapture[], settings: UserSettings[] = []) {
  const itemMap = new Map(items.map((i) => [i.id, i]));
  const settingMap = new Map(settings.map((s) => [s.user_id, s]));
  const repo: ReminderRepo = {
    async listTagged() { return [...itemMap.values()]; },
    async getSettings(u) { return settingMap.get(u); },
    async putSettings(s) { settingMap.set(s.user_id, s); },
    async writeReminderState(id, f) { Object.assign(itemMap.get(id)!, f); },
  };
  return { repo, itemMap, settingMap };
}

function capturingNotify() {
  const sent: { userId: string; ids: string[] }[] = [];
  return { sent, notify: async (userId: string, due: PendingCapture[]) => { sent.push({ userId, ids: due.map((d) => d.id) }); } };
}

const NOON = Date.UTC(2026, 0, 1, 12, 0, 0);
const neverQuiet = (over: Partial<UserSettings> = {}) =>
  ({ ...defaultSettings("u1", "UTC"), quiet_start: 0, quiet_end: 0, ...over });

describe("runCron", () => {
  it("lazy-initializes a freshly tagged item (no reminder_status) without surfacing it", async () => {
    const { repo, itemMap } = fakeRepo([item({ id: "a", reminder_status: undefined })], [neverQuiet()]);
    const { sent, notify } = capturingNotify();
    await runCron(repo, NOON, notify);
    const a = itemMap.get("a")!;
    expect(a.reminder_status).toBe("active");
    expect(a.next_due_at).toBe(NOON + PRESETS.normal.initialDelay); // due in the future
    expect(sent).toEqual([]); // not surfaced this cycle
  });

  it("surfaces a due active item, advances it, and notifies", async () => {
    const { repo, itemMap } = fakeRepo(
      [item({ id: "a", reminder_status: "active", cycle_count: 0, ignored_count: 0, next_due_at: NOON - DAY })],
      [neverQuiet()],
    );
    const { sent, notify } = capturingNotify();
    await runCron(repo, NOON, notify);
    expect(sent).toEqual([{ userId: "u1", ids: ["a"] }]);
    const a = itemMap.get("a")!;
    expect(a.cycle_count).toBe(1);
    expect(a.ignored_count).toBe(1); // surfaced-but-unacted
    expect(a.next_due_at).toBeGreaterThan(NOON);
    expect(a.last_surfaced_at).toBe(NOON);
  });

  it("holds during quiet hours (no notify, no advance)", async () => {
    const quiet = { ...defaultSettings("u1", "UTC"), quiet_start: 0, quiet_end: 23 }; // 12:00 is quiet
    const { repo, itemMap } = fakeRepo(
      [item({ id: "a", reminder_status: "active", cycle_count: 0, next_due_at: NOON - DAY })], [quiet],
    );
    const { sent, notify } = capturingNotify();
    await runCron(repo, NOON, notify);
    expect(sent).toEqual([]);
    expect(itemMap.get("a")!.cycle_count).toBe(0);
  });

  it("does not notify when reminders are paused", async () => {
    const { repo } = fakeRepo(
      [item({ id: "a", reminder_status: "active", next_due_at: NOON - DAY })],
      [neverQuiet({ reminders_paused: true })],
    );
    const { sent, notify } = capturingNotify();
    await runCron(repo, NOON, notify);
    expect(sent).toEqual([]);
  });

  it("respects the cadence gate (recent digest blocks the next)", async () => {
    const { repo } = fakeRepo(
      [item({ id: "a", reminder_status: "active", next_due_at: NOON - DAY })],
      [neverQuiet({ last_digest_at: NOON - 1000 })], // far within the balanced gap
    );
    const { sent, notify } = capturingNotify();
    await runCron(repo, NOON, notify);
    expect(sent).toEqual([]);
  });

  it("creates default settings when a user has none", async () => {
    const { repo, settingMap } = fakeRepo([item({ id: "a", reminder_status: "active", next_due_at: NOON - DAY })]);
    const { notify } = capturingNotify();
    await runCron(repo, NOON, notify);
    expect(settingMap.get("u1")).toBeDefined();
  });

  it("is idempotent on a double run in the same cycle (no double advance or double send)", async () => {
    const { repo, itemMap } = fakeRepo(
      [item({ id: "a", reminder_status: "active", cycle_count: 0, next_due_at: NOON - DAY })],
      [neverQuiet()],
    );
    const { sent, notify } = capturingNotify();
    await runCron(repo, NOON, notify);
    await runCron(repo, NOON, notify);
    expect(sent).toHaveLength(1);
    expect(itemMap.get("a")!.cycle_count).toBe(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/reminder/cron.test.ts`
Expected: FAIL — cannot find module `../../worker/cron`.

- [ ] **Step 4: Implement `worker/cron.ts`**

```ts
import type { PendingCapture } from "../src/types";
import { initialState, advance } from "../src/reminder/spacing";
import { markIgnored } from "../src/reminder/response";
import { selectDue, isQuietHours, cadenceGate } from "../src/reminder/digest";
import { defaultSettings, type ReminderRepo } from "./reminder-repo";

export type Notify = (userId: string, due: PendingCapture[]) => Promise<void>;

const HOUR = 3_600_000;

export async function runCron(repo: ReminderRepo, now: number, notify: Notify): Promise<void> {
  const cycleStart = Math.floor(now / HOUR) * HOUR;

  const byUser = new Map<string, PendingCapture[]>();
  for (const it of await repo.listTagged()) {
    if (!it.user_id) continue;
    const list = byUser.get(it.user_id) ?? [];
    list.push(it);
    byUser.set(it.user_id, list);
  }

  for (const [userId, items] of byUser) {
    // 1. Lazy-init freshly tagged items into the loop.
    for (const it of items) {
      if (!it.reminder_status) {
        const seed = initialState(it.importance, now);
        Object.assign(it, seed);
        await repo.writeReminderState(it.id, seed);
      }
    }

    // 2. Load (or create) settings; honor pause + quiet hours.
    let settings = await repo.getSettings(userId);
    if (!settings) {
      settings = defaultSettings(userId);
      await repo.putSettings(settings);
    }
    if (settings.reminders_paused || isQuietHours(settings, now)) continue;

    // 3. Select due items; gate on cadence (matters can pull forward).
    const due = selectDue(items, settings, now);
    if (due.length === 0) continue;
    const hasMatters = due.some((d) => d.importance === "matters");
    if (!cadenceGate(settings, now, hasMatters)) continue;

    // 4. Advance each surfaced item (idempotency guard), then notify.
    for (const it of due) {
      if ((it.last_surfaced_at ?? 0) >= cycleStart) continue;
      const fields = { ...advance(it, now), ignored_count: markIgnored(it).ignored_count };
      Object.assign(it, fields);
      await repo.writeReminderState(it.id, fields);
    }
    await notify(userId, due);
    await repo.putSettings({ ...settings, last_digest_at: now });
  }
}
```

- [ ] **Step 5: Run the test + type-check**

Run: `npx vitest run tests/reminder/cron.test.ts` then `npx tsc --noEmit`
Expected: PASS (7 tests); no type errors.

- [ ] **Step 6: Commit**

```bash
git add worker/reminder-repo.ts worker/cron.ts tests/reminder/cron.test.ts
git commit -m "feat: ReminderRepo port + cron orchestration (PRD 04a)"
```

---

### Task 6: D1 repo adapter + scheduled handler + device-sync user_id

**Files:**
- Create: `worker/d1-reminder-repo.ts`
- Modify: `worker/index.ts`
- Modify: `wrangler.toml`
- Test: `tests/worker-sync.test.ts` (add user_id + disjointness cases)

**Interfaces:**
- Consumes: `ReminderRepo` (Task 5), `runCron` (Task 5), `PendingCapture`/`UserSettings` (Task 1).
- Produces: `makeD1ReminderRepo(db): ReminderRepo`; `worker/index.ts` default export gains a `scheduled` handler; `WireRecord`/`UPSERT_SQL`/`toBind` carry `user_id` (and still exclude reminder columns).

- [ ] **Step 1: Write the failing worker-sync cases (device path carries user_id, excludes reminder columns)**

Add these cases inside the `describe("worker sync upsert", ...)` block in `tests/worker-sync.test.ts` (before its closing `});`):

```ts
  it("carries user_id as a device-owned column", () => {
    expect(UPSERT_SQL).toContain("user_id = excluded.user_id");
    expect(toBind(wire({ user_id: "u1" }))[16]).toBe("u1");
  });

  it("never writes server-owned reminder-state columns from the device path", () => {
    for (const col of ["reminder_status", "next_due_at", "cycle_count", "ignored_count", "last_surfaced_at"]) {
      expect(UPSERT_SQL).not.toContain(col);
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/worker-sync.test.ts`
Expected: FAIL — `user_id` is not in `UPSERT_SQL` and `toBind(...)[16]` is undefined.

- [ ] **Step 3: Add `user_id` to the device upsert in `worker/index.ts`**

Add `user_id?: string;` to the `WireRecord` interface (after `media_type?: string;`).

Replace the `UPSERT_SQL` column list, VALUES, and DO UPDATE clause so `user_id` is the 17th column (append it last in each):

```ts
export const UPSERT_SQL = `INSERT INTO pending_capture
   (id, canonical_url, raw_payload, captured_at, source, status, parse_ok,
    saved_at, title, thumbnail, description, topic_tags, importance, tagged_at, author, media_type,
    user_id)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(id) DO UPDATE SET
   status = excluded.status,
   saved_at = excluded.saved_at,
   description = excluded.description,
   topic_tags = excluded.topic_tags,
   importance = excluded.importance,
   tagged_at = excluded.tagged_at,
   author = excluded.author,
   media_type = excluded.media_type,
   user_id = excluded.user_id`;
```

Append `user_id` to the `toBind` return array as the final element:

```ts
    r.importance ?? null, r.tagged_at ?? null, r.author ?? null, r.media_type ?? null,
    r.user_id ?? null,
  ];
```

- [ ] **Step 4: Wire the `scheduled` handler + D1 repo in `worker/index.ts`**

Add imports at the top of the file:

```ts
import { runCron } from "./cron";
import { makeD1ReminderRepo } from "./d1-reminder-repo";
```

Add a `scheduled` method to the default export object (alongside `fetch`):

```ts
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const repo = makeD1ReminderRepo(env.DB);
    // 04a: delivery is stubbed — log the digest that WOULD be pushed. PRD 04b swaps in Web Push.
    await runCron(repo, Date.now(), async (userId, due) => {
      console.log(`[cron] digest for ${userId}: ${due.map((d) => d.id).join(", ")}`);
    });
  },
```

- [ ] **Step 5: Implement `worker/d1-reminder-repo.ts`**

```ts
import type { PendingCapture, UserSettings } from "../src/types";
import type { ReminderRepo } from "./reminder-repo";

const REMINDER_COLS = [
  "reminder_status", "next_due_at", "cycle_count", "ignored_count", "last_surfaced_at",
] as const;

export function makeD1ReminderRepo(db: D1Database): ReminderRepo {
  return {
    async listTagged() {
      const { results } = await db
        .prepare(`SELECT * FROM pending_capture WHERE status = 'tagged'`)
        .all<PendingCapture>();
      return results ?? [];
    },

    async getSettings(userId) {
      const row = await db
        .prepare(`SELECT * FROM user_settings WHERE user_id = ?`)
        .bind(userId)
        .first<Record<string, unknown>>();
      if (!row) return undefined;
      return {
        user_id: row.user_id as string,
        quiet_start: row.quiet_start as number,
        quiet_end: row.quiet_end as number,
        timezone: row.timezone as string,
        cadence: row.cadence as UserSettings["cadence"],
        reminders_paused: Boolean(row.reminders_paused),
        last_digest_at: (row.last_digest_at as number) ?? undefined,
        synced: true,
      };
    },

    async putSettings(s) {
      await db
        .prepare(
          `INSERT INTO user_settings
             (user_id, quiet_start, quiet_end, timezone, cadence, reminders_paused, last_digest_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end,
             timezone = excluded.timezone, cadence = excluded.cadence,
             reminders_paused = excluded.reminders_paused, last_digest_at = excluded.last_digest_at`,
        )
        .bind(
          s.user_id, s.quiet_start, s.quiet_end, s.timezone, s.cadence,
          s.reminders_paused ? 1 : 0, s.last_digest_at ?? null,
        )
        .run();
    },

    async writeReminderState(id, fields) {
      const cols = REMINDER_COLS.filter((c) => c in fields);
      if (cols.length === 0) return;
      const set = cols.map((c) => `${c} = ?`).join(", ");
      await db
        .prepare(`UPDATE pending_capture SET ${set} WHERE id = ?`)
        .bind(...cols.map((c) => (fields as Record<string, unknown>)[c] ?? null), id)
        .run();
    },
  };
}
```

- [ ] **Step 6: Add the cron trigger in `wrangler.toml`**

Append to the end of the file:

```toml
[triggers]
crons = ["0 * * * *"]
```

- [ ] **Step 7: Run tests + type-check + build**

Run: `npx vitest run` then `npm run build`
Expected: all tests pass; `tsc` clean; Vite build succeeds. (The D1 repo + `scheduled` handler are type-checked but exercised on-device; the cron logic itself is unit-tested in Task 5.)

- [ ] **Step 8: Commit**

```bash
git add worker/d1-reminder-repo.ts worker/index.ts wrangler.toml tests/worker-sync.test.ts
git commit -m "feat: D1 reminder repo + scheduled cron handler + device user_id sync (PRD 04a)"
```

---

### Task 7: Manual-verification doc + notes.md summary + final gate

**Files:**
- Modify: `docs/manual-verification.md`
- Modify: `notes.md`
- Modify: `docs/superpowers/specs/2026-06-24-prd04a-reminder-engine-core-design.md:8`

**Interfaces:**
- Consumes: the completed implementation.
- Produces: the manual checklist, the chronological PRD 04a summary, and a locked spec.

- [ ] **Step 1: Full verification gate**

Run: `npx vitest run` then `npm run build`
Expected: all tests green (record the count); `tsc` clean; build succeeds. Do NOT write the summary until this passes.

- [ ] **Step 2: Append the PRD 04a manual-verification section to `docs/manual-verification.md`**

```markdown

## PRD 04a — Reminder Engine Core (headless)

04a ships no user-visible UI; verify the engine advances D1 state on schedule. Web Push, the
review-view UI, and device pull/restore arrive in 04b.

### Setup
- Apply the new D1 columns + settings table. Fresh local DB: `wrangler d1 execute insave --local --file=schema.sql`.
  Existing remote DB (add by ALTER):
  `wrangler d1 execute insave --command "ALTER TABLE pending_capture ADD COLUMN user_id TEXT; ALTER TABLE pending_capture ADD COLUMN reminder_status TEXT; ALTER TABLE pending_capture ADD COLUMN next_due_at INTEGER; ALTER TABLE pending_capture ADD COLUMN cycle_count INTEGER; ALTER TABLE pending_capture ADD COLUMN ignored_count INTEGER; ALTER TABLE pending_capture ADD COLUMN last_surfaced_at INTEGER;"`
  Then create the settings table + index by re-running `schema.sql` (its `CREATE TABLE/INDEX IF NOT EXISTS` are safe on an existing DB).

### Checklist
- [ ] `wrangler dev --test-scheduled` then trigger the cron (`curl "http://localhost:8787/__scheduled"`): a tagged item with no reminder fields gets `reminder_status='active'` and a future `next_due_at` (lazy init).
- [ ] After making an item due (`next_due_at` in the past) and re-triggering: the cron logs a digest line, advances `cycle_count`, sets `last_surfaced_at`, and pushes `next_due_at` out.
- [ ] A `matters` item gets a sooner `next_due_at` than a `normal` item at the same cycle.
- [ ] Triggering twice in the same hour does not double-advance `cycle_count` or log a second digest (idempotency).
- [ ] Setting `reminders_paused=1` (or a quiet-hours window covering now) suppresses the digest.
- [ ] A device sync of a tagged item never overwrites `reminder_status`/`next_due_at`/`cycle_count` already set by the cron; `user_id` is present on synced rows.
```

- [ ] **Step 3: Append the PRD 04a summary to `notes.md`**

Append a new `## PRD 04a — Reminder Engine Core (headless) — 2026-06-24` section, same structure as the existing entries (What it is / Decisions made / How it works / Delivered (verified, with the real final test count + files from Step 1) / Still manual / open / Artifacts / Next PRDs). Under "Still manual / open" list: Web Push + review UI + device pull = 04b; the D1 `ALTER TABLE`; the §10 tuning constants. Reference the spec and this plan under Artifacts. Set Next to "04b Reminder Delivery (Web Push + review UI + device pull)".

- [ ] **Step 4: Lock the design spec**

In `docs/superpowers/specs/2026-06-24-prd04a-reminder-engine-core-design.md`, change line 8 `**Status:** Approved for planning` → `**Status:** Locked (implemented)`.

- [ ] **Step 5: Commit**

```bash
git add docs/manual-verification.md notes.md docs/superpowers/specs/2026-06-24-prd04a-reminder-engine-core-design.md
git commit -m "docs: PRD 04a manual checklist + notes summary + lock spec"
```

---

## Self-Review notes (plan vs. spec)

- **Spec §3 identity** → Task 4 (mint+stamp+backfill) + Task 6 (carry `user_id` to D1).
- **§4.1 reminder fields / §4.2 UserSettings** → Task 1 (types) + Task 4 (D1 + IDB).
- **§4.3 D1 schema + idx_due / §4.4 IDB v4** → Task 4.
- **§4.5 disjoint write paths** → Task 6 (device upsert excludes reminder cols, adds `user_id`; cron repo writes only reminder cols) + the worker-sync disjointness test.
- **§5.1 spacing** → Task 1. **§5.2 response** → Task 2. **§5.3 digest + quiet/cadence** → Task 3.
- **§6 cron (lazy init, gating, advance, idempotency, stub notify)** → Task 5 (logic) + Task 6 (`scheduled` + trigger).
- **§7 tag() unchanged re reminder state + user_id stamping** → Task 4 (no reminder writes in `tag`; stamping in `patch`/`put`).
- **§8 testing** → spacing/response/digest/cron unit tests (Tasks 1–3,5); worker-sync disjointness (Task 6); pending-store identity (Task 4); manual note (Task 7).
- **§9 acceptance criteria** → covered across Tasks 1–6 + manual checklist (Task 7).
- **Type/name consistency:** `initialState`/`advance`/`presetFor`/`PRESETS`/`DAY` (spacing) used identically in response, digest, cron tests/impl. `selectDue`/`isQuietHours`/`cadenceGate`/`DIGEST_CAP`/`CADENCE_GAP` identical in digest + cron. `ReminderRepo` method names (`listTagged`/`getSettings`/`putSettings`/`writeReminderState`) identical in port (Task 5), fake (Task 5 test), and D1 adapter (Task 6). `toBind` user_id index 16 matches the 17-column UPSERT order. `markIgnored` returns `{ ignored_count }`, composed in cron.
- **No placeholders:** every code step contains complete code; commands have expected output.
