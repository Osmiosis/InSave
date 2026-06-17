import { openInsaveDB, PENDING_STORE } from "./db";
import type { PendingCapture } from "./types";

export interface PendingStore {
  put(record: PendingCapture): Promise<void>;
  getByCanonicalUrl(canonicalUrl: string): Promise<PendingCapture | undefined>;
  listUnsynced(): Promise<PendingCapture[]>;
  markSynced(ids: string[]): Promise<void>;
}

export async function createPendingStore(): Promise<PendingStore> {
  const db = await openInsaveDB();

  return {
    async put(record) {
      await db.put(PENDING_STORE, record);
    },
    async getByCanonicalUrl(canonicalUrl) {
      if (!canonicalUrl) return undefined;
      return db.getFromIndex(PENDING_STORE, "by_canonical_url", canonicalUrl);
    },
    async listUnsynced() {
      const all = (await db.getAll(PENDING_STORE)) as PendingCapture[];
      return all.filter((r) => !r.synced);
    },
    async markSynced(ids) {
      const tx = db.transaction(PENDING_STORE, "readwrite");
      for (const id of ids) {
        const r = (await tx.store.get(id)) as PendingCapture | undefined;
        if (r) await tx.store.put({ ...r, synced: true });
      }
      await tx.done;
    },
  };
}
