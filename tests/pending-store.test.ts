import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { indexedDB } from "fake-indexeddb";
import { createPendingStore } from "../src/pending-store";
import type { PendingCapture } from "../src/types";

function rec(over: Partial<PendingCapture> = {}): PendingCapture {
  return {
    id: over.id ?? "id-1",
    canonical_url: over.canonical_url ?? "https://www.instagram.com/reel/ABC123",
    raw_payload: "{}",
    captured_at: 1000,
    source: "share_target",
    status: "pending",
    parse_ok: true,
    synced: false,
    ...over,
  };
}

describe("pending-store", () => {
  beforeEach(async () => {
    await new Promise<void>((res) => {
      const del = indexedDB.deleteDatabase("insave");
      del.onsuccess = () => res();
      del.onerror = () => res();
    });
  });

  it("puts and finds by canonical url", async () => {
    const store = await createPendingStore();
    await store.put(rec());
    const found = await store.getByCanonicalUrl("https://www.instagram.com/reel/ABC123");
    expect(found?.id).toBe("id-1");
  });

  it("returns undefined for unknown canonical url", async () => {
    const store = await createPendingStore();
    expect(await store.getByCanonicalUrl("https://www.instagram.com/reel/NOPE")).toBeUndefined();
  });

  it("lists only unsynced records", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a", synced: false }));
    await store.put(rec({ id: "b", canonical_url: "u-b", synced: true }));
    const unsynced = await store.listUnsynced();
    expect(unsynced.map((r) => r.id)).toEqual(["a"]);
  });

  it("marks records synced", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a", synced: false }));
    await store.markSynced(["a"]);
    expect(await store.listUnsynced()).toEqual([]);
  });
});
