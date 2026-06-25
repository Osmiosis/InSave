import { describe, it, expect } from "vitest";
import { handleCapture } from "../src/capture";
import type { PendingCapture } from "../src/types";
import type { SharePayload } from "../src/types";

function fakeStore(seed: PendingCapture[] = []) {
  const data = new Map<string, PendingCapture>();
  for (const r of seed) data.set(r.id, r);
  const store = {
    putCalls: [] as PendingCapture[],
    async put(r: PendingCapture) { data.set(r.id, r); store.putCalls.push(r); },
    async getByCanonicalUrl(u: string) {
      if (!u) return undefined;
      return [...data.values()].find((r) => r.canonical_url === u);
    },
    async listUnsynced() { return [...data.values()].filter((r) => !r.synced); },
    async markSynced() {},
    async listByStatus() { return []; },
    async tag() {},
    async dismiss() {},
    async restore() {},
    async listDistinctTags() { return []; },
    async move() {},
    async listByCollection() { return []; },
    async setImportance() {},
    async setDeadline() {},
  };
  return store;
}

const deps = { now: () => 1234, uuid: () => "uuid-fixed" };

describe("handleCapture", () => {
  it("saves a new reel and returns saved", async () => {
    const store = fakeStore();
    const res = await handleCapture(
      { url: "https://www.instagram.com/reel/ABC123/?igsh=x" } as SharePayload,
      store,
      deps,
    );
    expect(res.status).toBe("saved");
    expect(store.putCalls).toHaveLength(1);
    expect(store.putCalls[0].canonical_url).toBe("https://www.instagram.com/reel/ABC123");
    expect(store.putCalls[0].parse_ok).toBe(true);
  });

  it("detects a duplicate and does not write a second record", async () => {
    const existing: PendingCapture = {
      id: "old", canonical_url: "https://www.instagram.com/reel/ABC123",
      raw_payload: "{}", captured_at: 1, source: "share_target",
      status: "pending", parse_ok: true, synced: false,
    };
    const store = fakeStore([existing]);
    const res = await handleCapture(
      { url: "https://www.instagram.com/reel/ABC123/" } as SharePayload, store, deps);
    expect(res.status).toBe("dup");
    expect(store.putCalls).toHaveLength(0);
  });

  it("persists an unparsed payload with parse_ok=false rather than dropping it", async () => {
    const store = fakeStore();
    const res = await handleCapture({ text: "no link here" } as SharePayload, store, deps);
    expect(res.status).toBe("unparsed");
    expect(store.putCalls).toHaveLength(1);
    expect(store.putCalls[0].parse_ok).toBe(false);
    expect(store.putCalls[0].raw_payload).toBe(JSON.stringify({ text: "no link here" }));
  });

  it("returns error when the store write throws", async () => {
    const store = fakeStore();
    store.put = async () => { throw new Error("idb fail"); };
    const res = await handleCapture(
      { url: "https://www.instagram.com/reel/ABC123/" } as SharePayload, store, deps);
    expect(res.status).toBe("error");
  });
});
