import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { indexedDB } from "fake-indexeddb";
import { openInsaveDB, PENDING_STORE, COLLECTIONS_STORE, reownLocalData } from "../src/db";
import { pullCollections } from "../src/collections-sync";

async function resetDb() {
  await new Promise<void>((res) => {
    const del = indexedDB.deleteDatabase("insave");
    del.onsuccess = () => res();
    del.onerror = () => res();
  });
}

describe("reownLocalData", () => {
  beforeEach(resetDb);

  it("re-owns only this device's rows, leaving others untouched", async () => {
    const db = await openInsaveDB();
    await db.put(PENDING_STORE, { id: "p1", user_id: "anonX", canonical_url: "u1" });
    await db.put(PENDING_STORE, { id: "p2", user_id: "someoneElse", canonical_url: "u2" });
    await db.put(COLLECTIONS_STORE, { id: "c1", user_id: "anonX", name: "AI", created_at: 1, is_default: false });

    await reownLocalData("anonX", "acct1");

    expect(((await db.get(PENDING_STORE, "p1")) as { user_id: string }).user_id).toBe("acct1");
    expect(((await db.get(PENDING_STORE, "p2")) as { user_id: string }).user_id).toBe("someoneElse");
    expect(((await db.get(COLLECTIONS_STORE, "c1")) as { user_id: string }).user_id).toBe("acct1");
  });
});

describe("pullCollections", () => {
  beforeEach(resetDb);

  it("upserts each collection returned by the server", async () => {
    const upserted: Array<{ id: string; name: string }> = [];
    const store = { upsertPulled: async (c: { id: string; name: string }) => void upserted.push(c) };
    const fetchFn = async () =>
      ({
        ok: true,
        json: async () => ({
          collections: [
            { id: "c1", user_id: "acct", name: "AI", created_at: 1, is_default: false },
            { id: "c2", user_id: "acct", name: "Saved", created_at: 2, is_default: true },
          ],
        }),
      }) as unknown as Response;

    await pullCollections(store, fetchFn);
    expect(upserted.map((c) => c.name)).toEqual(["AI", "Saved"]);
  });

  it("no-ops on a non-OK response", async () => {
    let called = 0;
    const store = { upsertPulled: async () => void called++ };
    const fetchFn = async () => ({ ok: false, json: async () => ({}) }) as unknown as Response;
    await pullCollections(store, fetchFn);
    expect(called).toBe(0);
  });
});
