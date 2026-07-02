import { openInsaveDB, COLLECTIONS_STORE, getUserId } from "./db";
import type { Collection } from "./types";

export interface CollectionsStore {
  ensureDefault(): Promise<Collection>;
  list(): Promise<Collection[]>;
  create(name: string): Promise<Collection>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
  listUnsynced(): Promise<Collection[]>;
  markSynced(ids: string[]): Promise<void>;
  upsertPulled(c: Omit<Collection, "synced">): Promise<void>;
}

export async function createCollectionsStore(
  now: () => number = () => Date.now(),
  uuid: () => string = () => crypto.randomUUID(),
): Promise<CollectionsStore> {
  const db = await openInsaveDB();
  const userId = await getUserId(uuid); // shared identity (meta store), same as pending-store

  async function listAll(): Promise<Collection[]> {
    const all = (await db.getAllFromIndex(COLLECTIONS_STORE, "by_user", userId)) as Collection[];
    // Saved (default) first, then oldest-created first.
    return all.sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.created_at - b.created_at);
  }

  async function ensureDefault(): Promise<Collection> {
    const existing = (await listAll()).find((c) => c.is_default);
    if (existing) return existing;
    const def: Collection = {
      id: uuid(), user_id: userId, name: "Saved",
      created_at: now(), is_default: true, synced: false,
    };
    await db.put(COLLECTIONS_STORE, def);
    return def;
  }

  await ensureDefault();

  return {
    ensureDefault,
    list: listAll,
    async create(name) {
      const c: Collection = {
        id: uuid(), user_id: userId, name,
        created_at: now(), is_default: false, synced: false,
      };
      await db.put(COLLECTIONS_STORE, c);
      return c;
    },
    async rename(id, name) {
      const tx = db.transaction(COLLECTIONS_STORE, "readwrite");
      const c = (await tx.store.get(id)) as Collection | undefined;
      if (c) await tx.store.put({ ...c, name, synced: false });
      await tx.done;
    },
    async remove(id) {
      const c = (await db.get(COLLECTIONS_STORE, id)) as Collection | undefined;
      if (c?.is_default) throw new Error("cannot delete the default collection");
      await db.delete(COLLECTIONS_STORE, id);
    },
    async listUnsynced() {
      return (await listAll()).filter((c) => !c.synced);
    },
    async markSynced(ids) {
      const tx = db.transaction(COLLECTIONS_STORE, "readwrite");
      for (const id of ids) {
        const c = (await tx.store.get(id)) as Collection | undefined;
        if (c) await tx.store.put({ ...c, synced: true });
      }
      await tx.done;
    },
    // Overlay a collection pulled from the server (account-authoritative), so a
    // signed-in device sees collections created on other devices.
    async upsertPulled(c) {
      await db.put(COLLECTIONS_STORE, { ...c, synced: true });
    },
  };
}
