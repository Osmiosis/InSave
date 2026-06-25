import { describe, it, expect, vi } from "vitest";
import { drainCollections } from "../src/collections-sync";
import type { Collection } from "../src/types";

function col(id: string): Collection {
  return { id, user_id: "u1", name: id, created_at: 1, is_default: false, synced: false };
}

function storeWith(unsynced: Collection[]) {
  const marked: string[] = [];
  return {
    marked,
    async listUnsynced() { return unsynced; },
    async markSynced(ids: string[]) { marked.push(...ids); },
  };
}

describe("drainCollections", () => {
  it("posts unsynced collections and marks accepted ids synced", async () => {
    const store = storeWith([col("a"), col("b")]);
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ accepted: ["a", "b"] }), { status: 200 }));
    await drainCollections(store, fetchFn as unknown as typeof fetch);
    const [url, init] = (fetchFn.mock.calls[0] as unknown as [string, RequestInit]);
    expect(url).toBe("/api/collections");
    const sent = JSON.parse(init.body as string);
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toHaveProperty("synced"); // local-only flag stripped
    expect(store.marked.sort()).toEqual(["a", "b"]);
  });

  it("does nothing when nothing is unsynced", async () => {
    const store = storeWith([]);
    const fetchFn = vi.fn();
    await drainCollections(store, fetchFn as unknown as typeof fetch);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not mark synced on throw or non-ok", async () => {
    const s1 = storeWith([col("a")]);
    await drainCollections(s1, (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    expect(s1.marked).toEqual([]);
    const s2 = storeWith([col("a")]);
    await drainCollections(s2, (async () => new Response("err", { status: 500 })) as unknown as typeof fetch);
    expect(s2.marked).toEqual([]);
  });
});
