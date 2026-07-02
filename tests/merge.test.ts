import { describe, it, expect } from "vitest";
import {
  mergeContent,
  planPendingMerge,
  buildPendingStatements,
  buildCollectionMerge,
  type MergeRow,
} from "../worker/merge";

function row(over: Partial<MergeRow>): MergeRow {
  return {
    id: "id",
    canonical_url: "https://x/reel/A",
    status: null,
    saved_at: null,
    description: null,
    topic_tags: null,
    importance: null,
    tagged_at: null,
    author: null,
    media_type: null,
    collection_id: null,
    deadline_at: null,
    ...over,
  };
}

describe("mergeContent (field precedence)", () => {
  it("is additive: fills a field present only on the anon row", () => {
    const account = row({ importance: null, collection_id: null });
    const anon = row({ importance: "high", collection_id: "c1", tagged_at: 5 });
    const m = mergeContent(account, anon);
    expect(m.importance).toBe("high");
    expect(m.collection_id).toBe("c1");
  });

  it("keeps a field present only on the account row", () => {
    const account = row({ importance: "low", tagged_at: 9 });
    const anon = row({ importance: null });
    expect(mergeContent(account, anon).importance).toBe("low");
  });

  it("on a genuine conflict the more-recently-tagged row wins", () => {
    const account = row({ importance: "low", topic_tags: '["a"]', tagged_at: 10 });
    const anon = row({ importance: "high", topic_tags: '["b"]', tagged_at: 20 });
    const m = mergeContent(account, anon);
    expect(m.importance).toBe("high");
    expect(m.topic_tags).toBe('["b"]');
    expect(m.tagged_at).toBe(20);
  });

  it("account wins the conflict when it is the more-recently-tagged row", () => {
    const account = row({ importance: "low", tagged_at: 30 });
    const anon = row({ importance: "high", tagged_at: 20 });
    expect(mergeContent(account, anon).importance).toBe("low");
  });

  it("returns only device-owned fields (never server-owned reminder state)", () => {
    const m = mergeContent(row({}), row({}));
    expect(Object.keys(m).sort()).toEqual(
      [
        "author", "collection_id", "deadline_at", "description", "importance",
        "media_type", "saved_at", "status", "tagged_at", "topic_tags",
      ].sort(),
    );
    expect("next_due_at" in m).toBe(false);
    expect("reminder_status" in m).toBe(false);
  });
});

describe("planPendingMerge", () => {
  it("re-points an anon row whose url the account does not own", () => {
    const anon = [row({ id: "n1", canonical_url: "https://x/reel/NEW" })];
    const ops = planPendingMerge(anon, new Map());
    expect(ops).toEqual([{ kind: "repoint", id: "n1" }]);
  });

  it("coalesces an anon row that collides with an account url", () => {
    const acc = row({ id: "a1", canonical_url: "https://x/reel/DUP", importance: "low", tagged_at: 1 });
    const anon = [row({ id: "n1", canonical_url: "https://x/reel/DUP", importance: "high", tagged_at: 2 })];
    const ops = planPendingMerge(anon, new Map([[acc.canonical_url, acc]]));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: "coalesce", keepId: "a1", deleteId: "n1" });
    expect(ops[0].kind === "coalesce" && ops[0].fields.importance).toBe("high");
  });

  it("re-points (never coalesces) rows with an empty canonical_url", () => {
    const acc = row({ id: "a1", canonical_url: "" });
    const anon = [row({ id: "n1", canonical_url: "" })];
    const ops = planPendingMerge(anon, new Map([["", acc]]));
    expect(ops).toEqual([{ kind: "repoint", id: "n1" }]);
  });
});

describe("buildPendingStatements", () => {
  it("re-point guards on the anon owner (idempotent, non-destructive)", () => {
    const stmts = buildPendingStatements([{ kind: "repoint", id: "n1" }], "acct", "anon");
    expect(stmts).toHaveLength(1);
    expect(stmts[0].sql).toContain("UPDATE pending_capture SET user_id=?");
    expect(stmts[0].sql).toContain("WHERE id=? AND user_id=?");
    expect(stmts[0].params).toEqual(["acct", "n1", "anon"]);
  });

  it("coalesce updates the account row and deletes the anon row", () => {
    const fields = mergeContent(
      row({ id: "a1" }),
      row({ id: "n1", importance: "high", tagged_at: 1 }),
    );
    const stmts = buildPendingStatements(
      [{ kind: "coalesce", keepId: "a1", deleteId: "n1", fields }],
      "acct",
      "anon",
    );
    expect(stmts).toHaveLength(2);
    expect(stmts[0].sql).toMatch(/^UPDATE pending_capture SET /);
    expect(stmts[0].params[stmts[0].params.length - 1]).toBe("a1");
    expect(stmts[1].sql).toBe("DELETE FROM pending_capture WHERE id=? AND user_id=?");
    expect(stmts[1].params).toEqual(["n1", "anon"]);
  });
});

describe("buildCollectionMerge", () => {
  it("re-points all collections when there is no default collision", () => {
    const { reelRemap, collectionOps } = buildCollectionMerge("acct", "anon", null, "anonDef");
    expect(reelRemap).toEqual([]);
    expect(collectionOps).toHaveLength(1);
    expect(collectionOps[0].sql).toBe("UPDATE collections SET user_id=? WHERE user_id=?");
    expect(collectionOps[0].params).toEqual(["acct", "anon"]);
  });

  it("collapses two defaults: folds anon-default reels into the account default and drops it", () => {
    const { reelRemap, collectionOps } = buildCollectionMerge("acct", "anon", "accDef", "anonDef");
    // reel remap moves anon-default reels to the account default, before re-point
    expect(reelRemap[0].sql).toContain("UPDATE pending_capture SET collection_id=?");
    expect(reelRemap[0].params).toEqual(["accDef", "anon", "anonDef"]);
    // re-point every anon collection EXCEPT the anon default, then delete it
    expect(collectionOps[0].sql).toBe("UPDATE collections SET user_id=? WHERE user_id=? AND id<>?");
    expect(collectionOps[0].params).toEqual(["acct", "anon", "anonDef"]);
    expect(collectionOps[1].sql).toBe("DELETE FROM collections WHERE id=?");
    expect(collectionOps[1].params).toEqual(["anonDef"]);
  });
});
