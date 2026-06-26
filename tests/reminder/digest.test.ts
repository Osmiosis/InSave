import { describe, it, expect } from "vitest";
import { selectDue, isDeadlineDue, isQuietHours, cadenceGate, DIGEST_CAP, CADENCE_GAP } from "../../src/reminder/digest";
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

  it("orders high before normal, then most-overdue first", () => {
    const due = selectDue([
      item({ id: "n1", importance: "normal", next_due_at: 10 }),
      item({ id: "m1", importance: "high", next_due_at: 900 }),
      item({ id: "m2", importance: "high", next_due_at: 100 }),
    ], settings(), 1000);
    expect(due.map((i) => i.id)).toEqual(["m2", "m1", "n1"]);
  });

  it("ranks high before normal before low", () => {
    const due = selectDue([
      item({ id: "lo", importance: "low", next_due_at: 1 }),
      item({ id: "hi", importance: "high", next_due_at: 1 }),
      item({ id: "no", importance: "normal", next_due_at: 1 }),
    ], settings(), 1000);
    expect(due.map((i) => i.id)).toEqual(["hi", "no", "lo"]);
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
});

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
  it("a high item pulls the gap forward to the often interval", () => {
    const now = CADENCE_GAP.often + 1;
    expect(cadenceGate(settings({ last_digest_at: 0 }), now, false)).toBe(false);
    expect(cadenceGate(settings({ last_digest_at: 0 }), now, true)).toBe(true);
  });
});
