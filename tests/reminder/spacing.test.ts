import { describe, it, expect } from "vitest";
import { initialState, advance, PRESETS, DAY, presetFor, normalizeImportance } from "../../src/reminder/spacing";
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
    expect(initialState("high", 1000)).toEqual({
      reminder_status: "active", cycle_count: 0, ignored_count: 0,
      next_due_at: 1000 + PRESETS.high.initialDelay,
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

  it("high resurfaces sooner than normal at the same cycle", () => {
    const m = advance(item({ importance: "high", cycle_count: 0 }), 0).next_due_at;
    const n = advance(item({ importance: "normal", cycle_count: 0 }), 0).next_due_at;
    expect(m).toBeLessThan(n);
  });

  it("expires past maxCycles", () => {
    const a = advance(item({ importance: "normal", cycle_count: 4 }), 0); // 4 -> 5 > maxCycles 4
    expect(a.reminder_status).toBe("expired");
  });

  it("expires past maxAge even below maxCycles", () => {
    const old = item({ importance: "high", cycle_count: 1, tagged_at: 0 });
    const a = advance(old, PRESETS.high.maxAge + DAY);
    expect(a.reminder_status).toBe("expired");
  });

  it("records last_surfaced_at = now", () => {
    expect(advance(item(), 5555).last_surfaced_at).toBe(5555);
  });

  it("ignores ignored_count when computing the interval (no ignore penalty)", () => {
    const patient = advance(item({ importance: "high", cycle_count: 2, ignored_count: 0 }), 0).next_due_at;
    const ignored = advance(item({ importance: "high", cycle_count: 2, ignored_count: 5 }), 0).next_due_at;
    expect(ignored).toBe(patient);
  });

  it("does not shorten the maxAge horizon for ignored items", () => {
    // Below maxAge, well within maxCycles: must stay active regardless of ignores.
    const belowHorizon = PRESETS.high.maxAge - DAY;
    const a = advance(item({ importance: "high", cycle_count: 1, ignored_count: 5, tagged_at: 0 }), belowHorizon);
    expect(a.reminder_status).toBe("active");
  });
});

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
