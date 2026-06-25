import { describe, it, expect } from "vitest";
import { applyAction } from "../../src/reminder/action";
import { presetFor } from "../../src/reminder/spacing";
import type { PendingCapture } from "../../src/types";

function item(over: Partial<PendingCapture> = {}): PendingCapture {
  return {
    id: "i", canonical_url: "u", raw_payload: "{}", captured_at: 0,
    source: "import", status: "tagged", parse_ok: true, synced: true,
    importance: "high", reminder_status: "active", cycle_count: 2, ignored_count: 3, ...over,
  };
}

describe("applyAction", () => {
  it("done retires the item", () => {
    expect(applyAction(item(), "done", 1000)).toEqual({ reminder_status: "done" });
  });

  it("snooze defers one base interval and stays active", () => {
    expect(applyAction(item(), "snooze", 1000)).toEqual({
      reminder_status: "active", next_due_at: 1000 + presetFor("high").initialDelay,
    });
  });

  it("open resets ignored_count without retiring", () => {
    expect(applyAction(item(), "open", 1000)).toEqual({ ignored_count: 0 });
  });
});
