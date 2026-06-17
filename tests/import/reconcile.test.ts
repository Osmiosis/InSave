import { describe, it, expect } from "vitest";
import { reconcile } from "../../src/import/reconcile";
import type { ImportedItem } from "../../src/types";

function item(id: string, canonical_url: string, parse_ok = true): ImportedItem {
  return {
    id, canonical_url, author: "a", saved_at: 1, imported_at: 2,
    raw_payload: "{}", parse_ok, backlog_state: "dormant",
  };
}

function lookup(imported: string[], captures: string[]) {
  return {
    async existingImported(u: string) { return imported.includes(u); },
    async existingCapture(u: string) { return captures.includes(u); },
  };
}

describe("reconcile", () => {
  it("inserts genuinely new items", async () => {
    const res = await reconcile([item("a", "u-a"), item("b", "u-b")], lookup([], []));
    expect(res.toInsert.map((r) => r.id)).toEqual(["a", "b"]);
    expect(res.skippedExisting).toBe(0);
  });

  it("skips items already present as an imported item", async () => {
    const res = await reconcile([item("a", "u-a")], lookup(["u-a"], []));
    expect(res.toInsert).toEqual([]);
    expect(res.skippedExisting).toBe(1);
  });

  it("skips items already present as a capture/promoted record", async () => {
    const res = await reconcile([item("a", "u-a")], lookup([], ["u-a"]));
    expect(res.toInsert).toEqual([]);
    expect(res.skippedExisting).toBe(1);
  });

  it("always inserts unparsed items (no dedupe key)", async () => {
    const res = await reconcile([item("a", "", false)], lookup([], []));
    expect(res.toInsert.map((r) => r.id)).toEqual(["a"]);
  });
});
