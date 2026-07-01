import { describe, it, expect, vi } from "vitest";
import { reconcileAccount, type ReconcileDeps } from "../src/account-merge";

function deps(over: Partial<ReconcileDeps>): ReconcileDeps {
  return {
    getSession: async () => ({ user: { id: "acct1" } }),
    getLocalId: async () => "anonX",
    setLocalId: vi.fn(async () => {}),
    merge: vi.fn(async () => true),
    refresh: vi.fn(async () => {}),
    ...over,
  };
}

describe("reconcileAccount", () => {
  it("skips when not signed in", async () => {
    const setLocalId = vi.fn(async () => {});
    const merge = vi.fn(async () => true);
    const r = await reconcileAccount(deps({ getSession: async () => null, setLocalId, merge }));
    expect(r).toBe("skipped");
    expect(merge).not.toHaveBeenCalled();
    expect(setLocalId).not.toHaveBeenCalled();
  });

  it("skips when the local id already is the account (already merged)", async () => {
    const merge = vi.fn(async () => true);
    const r = await reconcileAccount(deps({ getLocalId: async () => "acct1", merge }));
    expect(r).toBe("skipped");
    expect(merge).not.toHaveBeenCalled();
  });

  it("merges: calls /api/merge with the anon id, swaps local id, re-pulls", async () => {
    const setLocalId = vi.fn(async () => {});
    const merge = vi.fn(async () => true);
    const refresh = vi.fn(async () => {});
    const r = await reconcileAccount(deps({ setLocalId, merge, refresh }));
    expect(r).toBe("merged");
    expect(merge).toHaveBeenCalledWith("anonX");
    expect(setLocalId).toHaveBeenCalledWith("acct1");
    expect(refresh).toHaveBeenCalled();
  });

  it("leaves the local id unchanged when the merge fails (retry next load)", async () => {
    const setLocalId = vi.fn(async () => {});
    const refresh = vi.fn(async () => {});
    const r = await reconcileAccount(deps({ merge: async () => false, setLocalId, refresh }));
    expect(r).toBe("failed");
    expect(setLocalId).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
