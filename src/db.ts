import { openDB, type IDBPDatabase } from "idb";

export const DB_NAME = "insave";
export const PENDING_STORE = "pending_capture";
export const IMPORTED_STORE = "imported_item";

// Single owner of the IndexedDB schema. Version 2 adds the imported_item store.
export async function openInsaveDB(): Promise<IDBPDatabase> {
  const db = await openDB(DB_NAME, 2, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        const os = database.createObjectStore(PENDING_STORE, { keyPath: "id" });
        os.createIndex("by_canonical_url", "canonical_url", { unique: false });
      }
      if (oldVersion < 2) {
        const os = database.createObjectStore(IMPORTED_STORE, { keyPath: "id" });
        os.createIndex("by_canonical_url", "canonical_url", { unique: false });
      }
    },
  });
  // Auto-close when another context requests a version change (e.g. deleteDatabase in tests).
  db.addEventListener("versionchange", () => db.close());
  return db;
}
