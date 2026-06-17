import { openInsaveDB, IMPORTED_STORE } from "../db";
import type { BacklogState, ImportedItem } from "../types";

export interface ImportedStore {
  bulkPut(items: ImportedItem[]): Promise<void>;
  getByCanonicalUrl(canonicalUrl: string): Promise<ImportedItem | undefined>;
  listAll(): Promise<ImportedItem[]>;
  listByState(state: BacklogState): Promise<ImportedItem[]>;
  setState(id: string, state: BacklogState): Promise<void>;
}

export async function createImportedStore(): Promise<ImportedStore> {
  const db = await openInsaveDB();

  return {
    async bulkPut(items) {
      const tx = db.transaction(IMPORTED_STORE, "readwrite");
      for (const it of items) await tx.store.put(it);
      await tx.done;
    },
    async getByCanonicalUrl(canonicalUrl) {
      if (!canonicalUrl) return undefined;
      return db.getFromIndex(IMPORTED_STORE, "by_canonical_url", canonicalUrl);
    },
    async listAll() {
      return (await db.getAll(IMPORTED_STORE)) as ImportedItem[];
    },
    async listByState(state) {
      const all = (await db.getAll(IMPORTED_STORE)) as ImportedItem[];
      return all.filter((r) => r.backlog_state === state);
    },
    async setState(id, state) {
      const tx = db.transaction(IMPORTED_STORE, "readwrite");
      const r = (await tx.store.get(id)) as ImportedItem | undefined;
      if (r) await tx.store.put({ ...r, backlog_state: state });
      await tx.done;
    },
  };
}
