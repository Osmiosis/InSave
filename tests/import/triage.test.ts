import { describe, it, expect } from "vitest";
import { groupAndSort } from "../../src/import/triage";
import type { ImportedItem } from "../../src/types";

function item(id: string, author: string, saved_at: number): ImportedItem {
  return {
    id, canonical_url: `u-${id}`, author, saved_at, imported_at: 0,
    raw_payload: "{}", parse_ok: true, backlog_state: "dormant", media_type: "reel",
  };
}

describe("groupAndSort", () => {
  it("groups by author, newest item first within a group", () => {
    const groups = groupAndSort([
      item("a1", "alice", 10),
      item("a2", "alice", 30),
      item("b1", "bob", 20),
    ]);
    const alice = groups.find((g) => g.author === "alice")!;
    expect(alice.items.map((i) => i.id)).toEqual(["a2", "a1"]);
  });

  it("orders groups by their most-recent save, newest group first", () => {
    const groups = groupAndSort([
      item("a1", "alice", 10),
      item("b1", "bob", 50),
    ]);
    expect(groups.map((g) => g.author)).toEqual(["bob", "alice"]);
  });

  it("buckets empty author under (unknown)", () => {
    const groups = groupAndSort([item("x", "", 5)]);
    expect(groups[0].author).toBe("(unknown)");
  });
});
