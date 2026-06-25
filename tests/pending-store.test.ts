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

  it("lists by status, newest first", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a", captured_at: 100 }));
    await store.put(rec({ id: "b", canonical_url: "u-b", captured_at: 300 }));
    await store.put(rec({ id: "c", canonical_url: "u-c", captured_at: 200, status: "tagged", topic_tags: ["x"] }));
    const pending = await store.listByStatus("pending");
    expect(pending.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("tags an item: sets status, tagged_at, tags, importance, unsynced", async () => {
    const store = await createPendingStore(() => 7777);
    await store.put(rec({ id: "a", canonical_url: "u-a", synced: true }));
    await store.tag("a", { topic_tags: ["claude tricks"], importance: "matters" });
    const [r] = await store.listByStatus("tagged");
    expect(r.id).toBe("a");
    expect(r.status).toBe("tagged");
    expect(r.tagged_at).toBe(7777);
    expect(r.topic_tags).toEqual(["claude tricks"]);
    expect(r.importance).toBe("matters");
    expect(r.synced).toBe(false);
  });

  it("tag defaults importance to normal", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a" }));
    await store.tag("a", { topic_tags: ["gym"] });
    const [r] = await store.listByStatus("tagged");
    expect(r.importance).toBe("normal");
  });

  it("tag is idempotent on the same id (no duplicate rows)", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a" }));
    await store.tag("a", { topic_tags: ["gym"] });
    await store.tag("a", { topic_tags: ["gym"] });
    expect(await store.listByStatus("tagged")).toHaveLength(1);
  });

  it("dismiss and restore flip status and mark unsynced", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a", synced: true }));
    await store.dismiss("a");
    expect((await store.listByStatus("dismissed")).map((r) => r.id)).toEqual(["a"]);
    await store.restore("a");
    expect((await store.listByStatus("pending")).map((r) => r.id)).toEqual(["a"]);
    expect((await store.getByCanonicalUrl("u-a"))?.synced).toBe(false);
  });

  it("listDistinctTags unions tags across tagged items, excluding dismissed", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a" }));
    await store.put(rec({ id: "b", canonical_url: "u-b" }));
    await store.put(rec({ id: "c", canonical_url: "u-c" }));
    await store.tag("a", { topic_tags: ["gym"] });
    await store.tag("b", { topic_tags: ["gym", "skincare"] });
    await store.tag("c", { topic_tags: ["robotics"] });
    await store.dismiss("c"); // dismissed item's tags drop out of the chip set
    expect(await store.listDistinctTags()).toEqual(["gym", "skincare"]);
  });

  it("stamps a minted user_id onto writes and persists it in meta", async () => {
    const store = await createPendingStore(() => 0, () => "user-xyz");
    await store.put(rec({ id: "a", canonical_url: "u-a" }));
    const r = await store.getByCanonicalUrl("u-a");
    expect(r?.user_id).toBe("user-xyz");
  });

  it("does not overwrite an existing user_id on a record", async () => {
    const store = await createPendingStore(() => 0, () => "user-xyz");
    await store.put(rec({ id: "b", canonical_url: "u-b", user_id: "other" }));
    expect((await store.getByCanonicalUrl("u-b"))?.user_id).toBe("other");
  });

  it("move sets collection_id and marks unsynced", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a", synced: true }));
    await store.move("a", "col-recipes");
    const r = await store.getByCanonicalUrl("u-a");
    expect(r?.collection_id).toBe("col-recipes");
    expect(r?.synced).toBe(false);
  });

  it("listByCollection returns explicit members", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a", collection_id: "col-x" }));
    await store.put(rec({ id: "b", canonical_url: "u-b", collection_id: "col-y" }));
    const xs = await store.listByCollection("col-x", "saved-id");
    expect(xs.map((r) => r.id)).toEqual(["a"]);
  });

  it("listByCollection treats null collection_id as Saved, newest first", async () => {
    const store = await createPendingStore();
    await store.put(rec({ id: "a", canonical_url: "u-a", captured_at: 100 }));               // null -> Saved
    await store.put(rec({ id: "b", canonical_url: "u-b", captured_at: 300 }));               // null -> Saved
    await store.put(rec({ id: "c", canonical_url: "u-c", captured_at: 200, collection_id: "saved-id" })); // explicit Saved
    await store.put(rec({ id: "d", canonical_url: "u-d", captured_at: 400, collection_id: "col-x" }));    // elsewhere
    const saved = await store.listByCollection("saved-id", "saved-id");
    expect(saved.map((r) => r.id)).toEqual(["b", "c", "a"]); // 300, 200, 100; d excluded
  });
});
