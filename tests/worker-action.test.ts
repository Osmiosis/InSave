import { describe, it, expect } from "vitest";
import { parseAction, parsePull } from "../worker/index";

describe("parseAction", () => {
  it("accepts a well-formed action body", () => {
    expect(parseAction({ user_id: "u1", ids: ["a", "b"], action: "snooze" })).toEqual({
      user_id: "u1", ids: ["a", "b"], action: "snooze",
    });
  });

  it("rejects malformed bodies", () => {
    expect(parseAction({ ids: ["a"], action: "done" })).toBeNull(); // no user_id
    expect(parseAction({ user_id: "u1", ids: [], action: "done" })).toBeNull(); // empty ids
    expect(parseAction({ user_id: "u1", ids: ["a"], action: "nope" })).toBeNull(); // bad action
    expect(parseAction({ user_id: "u1", ids: [1, 2], action: "done" })).toBeNull(); // non-string ids
    expect(parseAction(null)).toBeNull();
  });
});

describe("parsePull", () => {
  it("returns the user_id when present", () => {
    expect(parsePull("u1")).toBe("u1");
  });
  it("returns null for an empty/missing user_id", () => {
    expect(parsePull("")).toBeNull();
    expect(parsePull(null)).toBeNull();
  });
});
