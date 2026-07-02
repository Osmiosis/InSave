import { describe, it, expect, vi } from "vitest";
import { reconcileAccount, type ReconcileDeps } from "../src/account-merge";

function deps(over: Partial<ReconcileDeps>): ReconcileDeps {
  return {
    getSession: async () => ({ user: { id: "acct1" } }),
    getLocalId: async () => "anonX",
    reown: vi.fn(async () => {}),
    setLocalId: vi.fn(async () => {}),
    merge: vi.fn(async () => true),
    refresh: vi.fn(async () => {}),
    ...over,
  };
}

describe("reconcileAccount", () => {
  it("skips when not signed in", async () => {
    const merge = vi.fn(async () => true);
    const r = await reconcileAccount(deps({ getSession: async () => null, merge }));
    expect(r).toBe("skipped");
    expect(merge).not.toHaveBeenCalled();
  });

  it("skips when the local id already is the account (already merged)", async () => {
    const merge = vi.fn(async () => true);
    const r = await reconcileAccount(deps({ getLocalId: async () => "acct1", merge }));
    expect(r).toBe("skipped");
    expect(merge).not.toHaveBeenCalled();
  });

  it("merges, re-owns local rows, swaps the id, then refreshes", async () => {
    const calls: string[] = [];
    const d = deps({
      merge: vi.fn(async () => { calls.push("merge"); return true; }),
      reown: vi.fn(async () => { calls.push("reown"); }),
      setLocalId: vi.fn(async () => { calls.push("setLocalId"); }),
      refresh: vi.fn(async () => { calls.push("refresh"); }),
    });
    const r = await reconcileAccount(d);
    expect(r).toBe("merged");
    expect(d.merge).toHaveBeenCalledWith("anonX");
    expect(d.reown).toHaveBeenCalledWith("anonX", "acct1");
    expect(d.setLocalId).toHaveBeenCalledWith("acct1");
    // Order matters: re-own local rows before swapping identity, refresh last.
    expect(calls).toEqual(["merge", "reown", "setLocalId", "refresh"]);
  });

  it("leaves the local id unchanged when the merge fails (retry next load)", async () => {
    const reown = vi.fn(async () => {});
    const setLocalId = vi.fn(async () => {});
    const r = await reconcileAccount(deps({ merge: async () => false, reown, setLocalId }));
    expect(r).toBe("failed");
    expect(reown).not.toHaveBeenCalled();
    expect(setLocalId).not.toHaveBeenCalled();
  });
});
