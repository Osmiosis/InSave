import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { indexedDB } from "fake-indexeddb";
import { openInsaveDB, PENDING_STORE, COLLECTIONS_STORE, reownLocalData, setUserId, clearLocalData } from "../src/db";
import { pullCollections } from "../src/collections-sync";
import { createCollectionsStore } from "../src/collections-store";

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

describe("clearLocalData", () => {
  beforeEach(resetDb);

  it("wipes reels, collections and the stored user_id", async () => {
    const db = await openInsaveDB();
    await db.put(PENDING_STORE, { id: "p", user_id: "u", canonical_url: "x" });
    await db.put(COLLECTIONS_STORE, { id: "c", user_id: "u", name: "AI", created_at: 1, is_default: false });
    await db.put("meta", { key: "user_id", value: "u" });

    await clearLocalData();

    expect(await db.count(PENDING_STORE)).toBe(0);
    expect(await db.count(COLLECTIONS_STORE)).toBe(0);
    expect(await db.get("meta", "user_id")).toBeUndefined();
  });
});

describe("pullCollections", () => {
  beforeEach(resetDb);

  it("mirrors the full server set into the store", async () => {
    let mirrored: Array<{ id: string; name: string }> = [];
    const store = {
      reconcilePulled: async (cols: Array<{ id: string; name: string }>) => void (mirrored = cols),
    };
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
    expect(mirrored.map((c) => c.name)).toEqual(["AI", "Saved"]);
  });

  it("does not mirror on a non-OK response (never wrongly deletes local data)", async () => {
    let called = 0;
    const store = { reconcilePulled: async () => void called++ };
    const fetchFn = async () => ({ ok: false, json: async () => ({}) }) as unknown as Response;
    await pullCollections(store, fetchFn);
    expect(called).toBe(0);
  });
});

describe("reconcilePulled (collection deletion mirror)", () => {
  beforeEach(resetDb);

  function counter(prefix = "c") {
    let n = 0;
    return () => `${prefix}${n++}`;
  }

  it("deletes a synced local collection the server dropped, keeps the server set", async () => {
    const store = await createCollectionsStore(() => 1000, counter()); // owner "c0", default "c1"
    const keep = await store.create("KeepThenDrop"); // "c2"
    const all = await store.list();
    await store.markSynced(all.map((c) => c.id)); // both now synced (pushed)

    // Server no longer has the created collection (e.g. collapsed/deleted elsewhere),
    // but adds one from another device.
    await store.reconcilePulled([
      { id: "c1", user_id: "c0", name: "Saved", created_at: 1000, is_default: true },
      { id: "sX", user_id: "c0", name: "FromOtherDevice", created_at: 2000, is_default: false },
    ]);

    const ids = (await store.list()).map((c) => c.id).sort();
    expect(ids).toEqual(["c1", "sX"]);
    expect(ids).not.toContain(keep.id); // synced-but-server-dropped -> deleted
  });

  it("preserves an unsynced local collection absent from the server", async () => {
    const store = await createCollectionsStore(() => 1000, counter());
    const draft = await store.create("Draft"); // unsynced (never pushed)
    await store.reconcilePulled([
      { id: "c1", user_id: "c0", name: "Saved", created_at: 1000, is_default: true },
    ]);
    const ids = (await store.list()).map((c) => c.id);
    expect(ids).toContain(draft.id); // unsynced -> kept
  });
});

describe("full client merge flow keeps a single Saved (integration)", () => {
  beforeEach(resetDb);

  it("re-owns local data, then the pull deletes the collapsed duplicate default", async () => {
    const db = await openInsaveDB();
    // This device's own synced default "Saved" (S_B), created while anonymous.
    await db.put(COLLECTIONS_STORE, {
      id: "S_B", user_id: "anon", name: "Saved", created_at: 1, is_default: true, synced: true,
    });

    // The swap, exactly as reconcileAccount does it: re-own, then set the id.
    await reownLocalData("anon", "acct");
    await setUserId("acct");

    // The server, after the default-collapse merge, has only the account default.
    const store = await createCollectionsStore(() => 1, () => "unused");
    const fetchFn = async () =>
      ({
        ok: true,
        json: async () => ({
          collections: [{ id: "S_A", user_id: "acct", name: "Saved", created_at: 0, is_default: true }],
        }),
      }) as unknown as Response;
    await pullCollections(store, fetchFn);

    const saved = (await store.list()).filter((c) => c.name === "Saved");
    expect(saved.map((c) => c.id)).toEqual(["S_A"]); // S_B collapsed away -> deleted; one Saved
  });
});
