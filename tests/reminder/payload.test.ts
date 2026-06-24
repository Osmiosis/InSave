import { describe, it, expect } from "vitest";
import { assemblePayload } from "../../src/reminder/payload";
import type { PendingCapture } from "../../src/types";

function item(id: string): PendingCapture {
  return {
    id, canonical_url: "u", raw_payload: "{}", captured_at: 0,
    source: "import", status: "tagged", parse_ok: true, synced: true,
  };
}

describe("assemblePayload", () => {
  it("includes user_id, ids, and a singular body for one item", () => {
    const p = JSON.parse(assemblePayload("u1", [item("a")]));
    expect(p).toEqual({ title: "InSave", body: "1 reel worth revisiting", count: 1, user_id: "u1", ids: ["a"] });
  });

  it("includes all ids and a plural body for several items", () => {
    const p = JSON.parse(assemblePayload("u1", [item("a"), item("b"), item("c")]));
    expect(p.body).toBe("3 reels worth revisiting");
    expect(p.count).toBe(3);
    expect(p.ids).toEqual(["a", "b", "c"]);
  });
});
