import { describe, it, expect, vi } from "vitest";
import { drainAll } from "../src/drain-all";

function pendingStub(unsynced: { id: string }[]) {
  return { listUnsynced: vi.fn(async () => unsynced), markSynced: vi.fn(async () => {}) };
}
function collectionsStub(unsynced: { id: string }[]) {
  return { listUnsynced: vi.fn(async () => unsynced), markSynced: vi.fn(async () => {}) };
}

describe("drainAll", () => {
  it("drains both the pending and collections rails", async () => {
    const pending = pendingStub([{ id: "p1" }]);
    const collections = collectionsStub([{ id: "c1" }]);
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ accepted: ["p1", "c1"] }), { status: 200 });
    });
    await drainAll(pending as never, collections as never, fetchFn as unknown as typeof fetch);
    expect(urls).toContain("/api/sync");
    expect(urls).toContain("/api/collections");
  });

  it("a failure on one rail does not prevent the other or throw", async () => {
    const pending = { listUnsynced: vi.fn(async () => { throw new Error("boom"); }), markSynced: vi.fn() };
    const collections = collectionsStub([{ id: "c1" }]);
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ accepted: ["c1"] }), { status: 200 }));
    await drainAll(pending as never, collections as never, fetchFn as unknown as typeof fetch);
    expect(collections.listUnsynced).toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledWith("/api/collections", expect.anything());
  });
});
