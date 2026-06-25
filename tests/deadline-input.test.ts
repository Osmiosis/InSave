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
