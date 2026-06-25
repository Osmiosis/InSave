import { describe, it, expect } from "vitest";
import { capturedRedirectUrl } from "../src/captured-url";

describe("capturedRedirectUrl", () => {
  it("appends the record id when present", () => {
    expect(capturedRedirectUrl("saved", "abc")).toBe("/captured.html?status=saved&id=abc");
  });

  it("omits the id when absent (e.g. error path)", () => {
    expect(capturedRedirectUrl("error")).toBe("/captured.html?status=error");
  });

  it("encodes the id", () => {
    expect(capturedRedirectUrl("dup", "a b/c")).toBe("/captured.html?status=dup&id=a%20b%2Fc");
  });
});
