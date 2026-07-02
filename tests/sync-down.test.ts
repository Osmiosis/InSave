import { describe, it, expect, vi } from "vitest";
import { syncDownIfSignedIn, type SyncDownDeps } from "../src/sync-down";

const store = { upsertPulled: async () => {} };

function deps(over: Partial<SyncDownDeps>): SyncDownDeps {
  return {
    getSession: async () => ({ user: { id: "acct1" } }),
    pullCollections: vi.fn(async () => {}),
    pullReels: vi.fn(async () => {}),
    ...over,
  };
}

describe("syncDownIfSignedIn", () => {
  it("pulls collections and reels when signed in", async () => {
    const d = deps({});
    const did = await syncDownIfSignedIn(store, d);
    expect(did).toBe(true);
    expect(d.pullCollections).toHaveBeenCalledWith(store);
    expect(d.pullReels).toHaveBeenCalled();
  });

  it("no-ops when signed out (anonymous fast path)", async () => {
    const d = deps({ getSession: async () => null });
    const did = await syncDownIfSignedIn(store, d);
    expect(did).toBe(false);
    expect(d.pullCollections).not.toHaveBeenCalled();
    expect(d.pullReels).not.toHaveBeenCalled();
  });
});
