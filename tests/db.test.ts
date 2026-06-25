import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { indexedDB } from "fake-indexeddb";
import { openInsaveDB, PENDING_STORE, getUserId } from "../src/db";

describe("db schema", () => {
  beforeEach(async () => {
    await new Promise<void>((res) => {
      const del = indexedDB.deleteDatabase("insave");
      del.onsuccess = () => res();
      del.onerror = () => res();
    });
  });

  it("has a by_status index on pending_capture", async () => {
    const db = await openInsaveDB();
    const tx = db.transaction(PENDING_STORE, "readonly");
    expect([...tx.store.indexNames]).toContain("by_status");
    expect([...tx.store.indexNames]).toContain("by_canonical_url");
  });

  it("opens at version 5 with user_settings, meta, and collections stores", async () => {
    const db = await openInsaveDB();
    expect(db.version).toBe(5);
    expect([...db.objectStoreNames]).toContain("user_settings");
    expect([...db.objectStoreNames]).toContain("meta");
    expect([...db.objectStoreNames]).toContain("collections");
  });

  it("getUserId mints once and returns the same id thereafter", async () => {
    const first = await getUserId(() => "minted-id");
    const second = await getUserId(() => "different-id");
    expect(first).toBe("minted-id");
    expect(second).toBe("minted-id"); // already minted; uuid fn ignored
  });
});
