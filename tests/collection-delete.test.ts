import { describe, it, expect } from "vitest";
import { planCollectionDelete } from "../src/collection-delete";
import type { PendingCapture } from "../src/types";

function rec(id: string): PendingCapture {
  return { id, canonical_url: "u", raw_payload: "{}", captured_at: 0, source: "import", status: "tagged", parse_ok: true, synced: true };
}

describe("planCollectionDelete", () => {
  it("move: re-homes every member to Saved, then removes the collection", () => {
    const plan = planCollectionDelete([rec("a"), rec("b")], "saved-id", "move");
    expect(plan.ops).toEqual([
      { kind: "move", id: "a", to: "saved-id" },
      { kind: "move", id: "b", to: "saved-id" },
    ]);
    expect(plan.removeCollection).toBe(true);
  });

  it("dismiss: dismisses every member, then removes the collection", () => {
    const plan = planCollectionDelete([rec("a")], "saved-id", "dismiss");
    expect(plan.ops).toEqual([{ kind: "dismiss", id: "a" }]);
    expect(plan.removeCollection).toBe(true);
  });

  it("empty collection: no ops but still removes", () => {
    expect(planCollectionDelete([], "saved-id", "move")).toEqual({ ops: [], removeCollection: true });
  });

  it("cancel: no ops, does not remove", () => {
    expect(planCollectionDelete([rec("a")], "saved-id", "cancel")).toEqual({ ops: [], removeCollection: false });
  });
});
