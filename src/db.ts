import { openDB, type IDBPDatabase } from "idb";

export const DB_NAME = "insave";
export const PENDING_STORE = "pending_capture";
export const IMPORTED_STORE = "imported_item";
export const USER_SETTINGS_STORE = "user_settings";
export const META_STORE = "meta";
export const COLLECTIONS_STORE = "collections";

// Single owner of the IndexedDB schema. v2 adds imported_item; v3 adds a
// by_status index on pending_capture for the Tag Queue; v5 adds collections.
export async function openInsaveDB(): Promise<IDBPDatabase> {
  const db = await openDB(DB_NAME, 5, {
    upgrade(database, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        const os = database.createObjectStore(PENDING_STORE, { keyPath: "id" });
        os.createIndex("by_canonical_url", "canonical_url", { unique: false });
      }
      if (oldVersion < 2) {
        const os = database.createObjectStore(IMPORTED_STORE, { keyPath: "id" });
        os.createIndex("by_canonical_url", "canonical_url", { unique: false });
      }
      if (oldVersion < 3) {
        // Existing pending records already carry status="pending"; only the index is new.
        tx.objectStore(PENDING_STORE).createIndex("by_status", "status", { unique: false });
      }
      if (oldVersion < 4) {
        database.createObjectStore(USER_SETTINGS_STORE, { keyPath: "user_id" });
        database.createObjectStore(META_STORE, { keyPath: "key" });
      }
      if (oldVersion < 5) {
        const os = database.createObjectStore(COLLECTIONS_STORE, { keyPath: "id" });
        os.createIndex("by_user", "user_id", { unique: false });
      }
    },
  });
  // Auto-close when another context requests a version change (e.g. deleteDatabase in tests).
  db.addEventListener("versionchange", () => db.close());
  return db;
}

// Reads (or mints once) the device's own user_id from the meta store. Shared by the
// pending-store and the push-enable flow so both agree on identity.
export async function getUserId(uuid: () => string = () => crypto.randomUUID()): Promise<string> {
  const db = await openInsaveDB();
  const meta = (await db.get(META_STORE, "user_id")) as { key: string; value: string } | undefined;
  if (meta) return meta.value;
  const value = uuid();
  await db.put(META_STORE, { key: "user_id", value });
  return value;
}
