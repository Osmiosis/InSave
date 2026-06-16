import { openDB, type IDBPDatabase } from "idb";
import type { PendingCapture } from "./types";

const DB_NAME = "insave";
const STORE = "pending_capture";

export interface PendingStore {
  put(record: PendingCapture): Promise<void>;
  getByCanonicalUrl(canonicalUrl: string): Promise<PendingCapture | undefined>;
  listUnsynced(): Promise<PendingCapture[]>;
  markSynced(ids: string[]): Promise<void>;
}

export async function createPendingStore(): Promise<PendingStore> {
  const db: IDBPDatabase = await openDB(DB_NAME, 1, {
    upgrade(database) {
      const os = database.createObjectStore(STORE, { keyPath: "id" });
      os.createIndex("by_canonical_url", "canonical_url", { unique: false });
    },
  });

  // Auto-close when another context requests a version change (e.g. deleteDatabase in tests)
  db.addEventListener("versionchange", () => {
    db.close();
  });

  return {
    async put(record) {
      await db.put(STORE, record);
    },
    async getByCanonicalUrl(canonicalUrl) {
      if (!canonicalUrl) return undefined;
      return db.getFromIndex(STORE, "by_canonical_url", canonicalUrl);
    },
    async listUnsynced() {
      const all = (await db.getAll(STORE)) as PendingCapture[];
      return all.filter((r) => !r.synced);
    },
    async markSynced(ids) {
      const tx = db.transaction(STORE, "readwrite");
      for (const id of ids) {
        const r = (await tx.store.get(id)) as PendingCapture | undefined;
        if (r) await tx.store.put({ ...r, synced: true });
      }
      await tx.done;
    },
  };
}
