import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { indexedDB } from "fake-indexeddb";
import { createCollectionsStore } from "../src/collections-store";

// Incrementing uuid so the minted user_id and each collection id are distinct.
function counter(prefix = "c") {
  let n = 0;
  return () => `${prefix}${n++}`;
}

describe("collections-store", () => {
  beforeEach(async () => {
    await new Promise<void>((res) => {
      const del = indexedDB.deleteDatabase("insave");
      del.onsuccess = () => res();
      del.onerror = () => res();
    });
  });

  it("ensures a single undeletable Saved default on creation", async () => {
    const store = await createCollectionsStore(() => 1000, counter());
    const all = await store.list();
    const defaults = all.filter((c) => c.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].name).toBe("Saved");
  });

  it("ensureDefault is idempotent (never a second Saved)", async () => {
    const store = await createCollectionsStore(() => 1000, counter());
    await store.ensureDefault();
    await store.ensureDefault();
    expect((await store.list()).filter((c) => c.is_default)).toHaveLength(1);
  });

  it("create adds a non-default, unsynced collection; list puts Saved first", async () => {
    const store = await createCollectionsStore(() => 1000, counter());
    const recipes = await store.create("Recipes");
    expect(recipes.is_default).toBe(false);
    expect(recipes.synced).toBe(false);
    const names = (await store.list()).map((c) => c.name);
    expect(names[0]).toBe("Saved");
    expect(names).toContain("Recipes");
  });

  it("rename changes the name and marks unsynced", async () => {
    const store = await createCollectionsStore(() => 1000, counter());
    const c = await store.create("Gymm");
    await store.markSynced([c.id]);
    await store.rename(c.id, "Gym");
    const found = (await store.list()).find((x) => x.id === c.id)!;
    expect(found.name).toBe("Gym");
    expect(found.synced).toBe(false);
  });

  it("remove deletes a normal collection but throws on the default", async () => {
    const store = await createCollectionsStore(() => 1000, counter());
    const c = await store.create("Temp");
    await store.remove(c.id);
    expect((await store.list()).some((x) => x.id === c.id)).toBe(false);
    const saved = (await store.list()).find((x) => x.is_default)!;
    await expect(store.remove(saved.id)).rejects.toThrow();
  });

  it("listUnsynced returns only unsynced; markSynced clears them", async () => {
    const store = await createCollectionsStore(() => 1000, counter());
    const a = await store.create("A");
    await store.markSynced([a.id]);
    await store.create("B");
    const unsynced = await store.listUnsynced();
    expect(unsynced.map((c) => c.name)).toContain("B");
    expect(unsynced.map((c) => c.name)).not.toContain("A");
  });
});
