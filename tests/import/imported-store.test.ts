import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { indexedDB } from "fake-indexeddb";
import { createImportedStore } from "../../src/import/imported-store";
import { createPendingStore } from "../../src/pending-store";
import type { ImportedItem } from "../../src/types";

function item(over: Partial<ImportedItem> = {}): ImportedItem {
  return {
    id: over.id ?? "i-1",
    canonical_url: over.canonical_url ?? "https://www.instagram.com/reel/A",
    author: over.author ?? "alice",
    saved_at: over.saved_at ?? 1000,
    imported_at: 2000,
    raw_payload: "{}",
    parse_ok: true,
    backlog_state: over.backlog_state ?? "dormant",
    media_type: over.media_type ?? "reel",
    ...over,
  };
}

describe("imported-store", () => {
  beforeEach(async () => {
    await new Promise<void>((res) => {
      const del = indexedDB.deleteDatabase("insave");
      del.onsuccess = () => res();
      del.onerror = () => res();
      del.onblocked = () => res();
    });
  });

  it("bulkPut then listAll returns all items", async () => {
    const store = await createImportedStore();
    await store.bulkPut([item({ id: "a", canonical_url: "u-a" }), item({ id: "b", canonical_url: "u-b" })]);
    const all = await store.listAll();
    expect(all.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("getByCanonicalUrl finds a stored item", async () => {
    const store = await createImportedStore();
    await store.bulkPut([item({ id: "a", canonical_url: "u-a" })]);
    expect((await store.getByCanonicalUrl("u-a"))?.id).toBe("a");
    expect(await store.getByCanonicalUrl("nope")).toBeUndefined();
  });

  it("listByState filters by backlog_state", async () => {
    const store = await createImportedStore();
    await store.bulkPut([
      item({ id: "a", canonical_url: "u-a", backlog_state: "dormant" }),
      item({ id: "b", canonical_url: "u-b", backlog_state: "promoted" }),
    ]);
    expect((await store.listByState("dormant")).map((r) => r.id)).toEqual(["a"]);
    expect((await store.listByState("promoted")).map((r) => r.id)).toEqual(["b"]);
  });

  it("setState transitions an item", async () => {
    const store = await createImportedStore();
    await store.bulkPut([item({ id: "a", canonical_url: "u-a", backlog_state: "dormant" })]);
    await store.setState("a", "promoted");
    expect((await store.getByCanonicalUrl("u-a"))?.backlog_state).toBe("promoted");
  });

  it("coexists with the pending_capture store on the same v2 database", async () => {
    const imported = await createImportedStore();
    const pending = await createPendingStore();
    await imported.bulkPut([item({ id: "a", canonical_url: "u-a" })]);
    await pending.put({
      id: "p", canonical_url: "u-p", raw_payload: "{}", captured_at: 1,
      source: "share_target", status: "pending", parse_ok: true, synced: false,
    });
    expect((await imported.listAll()).length).toBe(1);
    expect(await pending.getByCanonicalUrl("u-p")).toBeTruthy();
  });
});
