import { describe, it, expect } from "vitest";
import { recentChips } from "../src/collection-picker";
import type { Collection } from "../src/types";

function col(over: Partial<Collection>): Collection {
  return { id: "x", user_id: "u", name: "X", created_at: 0, is_default: false, synced: true, ...over };
}

describe("recentChips", () => {
  it("excludes the default and orders newest-created first", () => {
    const cols = [
      col({ id: "s", name: "Saved", is_default: true, created_at: 1 }),
      col({ id: "a", name: "A", created_at: 10 }),
      col({ id: "b", name: "B", created_at: 30 }),
      col({ id: "c", name: "C", created_at: 20 }),
    ];
    expect(recentChips(cols).map((c) => c.name)).toEqual(["B", "C", "A"]);
  });

  it("caps the result (default 5)", () => {
    const cols = Array.from({ length: 8 }, (_, i) => col({ id: `c${i}`, name: `C${i}`, created_at: i }));
    expect(recentChips(cols)).toHaveLength(5);
    expect(recentChips(cols, 2)).toHaveLength(2);
  });

  it("returns nothing when only the default exists", () => {
    expect(recentChips([col({ id: "s", is_default: true })])).toEqual([]);
  });
});
