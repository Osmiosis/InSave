import { describe, it, expect, vi } from "vitest";
import { drainSync } from "../src/sync";
import type { PendingCapture, PendingStore } from "../src/types";

function rec(id: string): PendingCapture {
  return {
    id, canonical_url: `https://www.instagram.com/reel/${id}`,
    raw_payload: "{}", captured_at: 1, source: "share_target",
    status: "pending", parse_ok: true, synced: false,
  };
}

function storeWith(unsynced: PendingCapture[]): PendingStore & { marked: string[] } {
  const marked: string[] = [];
  return {
    marked,
    async put() {},
    async getByCanonicalUrl() { return undefined; },
    async listUnsynced() { return unsynced; },
    async markSynced(ids) { marked.push(...ids); },
    async listByStatus() { return []; },
    async tag() {},
    async dismiss() {},
    async restore() {},
    async listDistinctTags() { return []; },
  };
}

describe("drainSync", () => {
  it("posts unsynced records and marks accepted ids synced", async () => {
    const store = storeWith([rec("a"), rec("b")]);
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ accepted: ["a", "b"] }), { status: 200 }));
    await drainSync(store, fetchFn);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("/api/sync");
    const sent = JSON.parse(init!.body as string);
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toHaveProperty("synced"); // local-only flag stripped by toWire
    expect(store.marked.sort()).toEqual(["a", "b"]);
  });

  it("does nothing when there is nothing unsynced", async () => {
    const store = storeWith([]);
    const fetchFn = vi.fn();
    await drainSync(store, fetchFn);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not mark anything synced when the request fails", async () => {
    const store = storeWith([rec("a")]);
    const fetchFn = vi.fn(async () => { throw new Error("offline"); });
    await drainSync(store, fetchFn);
    expect(store.marked).toEqual([]);
  });

  it("does not mark synced on a non-ok response", async () => {
    const store = storeWith([rec("a")]);
    const fetchFn = vi.fn(async () => new Response("err", { status: 500 }));
    await drainSync(store, fetchFn);
    expect(store.marked).toEqual([]);
  });
});
