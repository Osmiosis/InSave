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
    const r = snooze(item({ importance: "high" }), 1000);
    expect(r.reminder_status).toBe("active");
    expect(r.next_due_at).toBe(1000 + presetFor("high").initialDelay);
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
