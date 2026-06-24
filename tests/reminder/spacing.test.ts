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
