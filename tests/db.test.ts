import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { indexedDB } from "fake-indexeddb";
import { openInsaveDB, PENDING_STORE } from "../src/db";

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

  it("opens at version 4 with user_settings and meta stores", async () => {
    const db = await openInsaveDB();
    expect(db.version).toBe(4);
    expect([...db.objectStoreNames]).toContain("user_settings");
    expect([...db.objectStoreNames]).toContain("meta");
  });
});
