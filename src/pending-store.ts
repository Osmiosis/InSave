import { openInsaveDB, PENDING_STORE, META_STORE } from "./db";
import type { CaptureStatus, PendingCapture } from "./types";

export interface PendingStore {
  put(record: PendingCapture): Promise<void>;
  getByCanonicalUrl(canonicalUrl: string): Promise<PendingCapture | undefined>;
  listUnsynced(): Promise<PendingCapture[]>;
  markSynced(ids: string[]): Promise<void>;
  listByStatus(status: CaptureStatus): Promise<PendingCapture[]>;
  tag(id: string, opts: { topic_tags: string[]; importance?: "normal" | "matters" }): Promise<void>;
  dismiss(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  listDistinctTags(): Promise<string[]>;
}

export async function createPendingStore(
  now: () => number = () => Date.now(),
  uuid: () => string = () => crypto.randomUUID(),
): Promise<PendingStore> {
  const db = await openInsaveDB();

  // Mint (once) and read the device's own user_id; backfill any pre-existing records.
  let meta = (await db.get(META_STORE, "user_id")) as { key: string; value: string } | undefined;
  if (!meta) {
    meta = { key: "user_id", value: uuid() };
    await db.put(META_STORE, meta);
    const tx = db.transaction(PENDING_STORE, "readwrite");
    let cursor = await tx.store.openCursor();
    while (cursor) {
      const r = cursor.value as PendingCapture;
      if (!r.user_id) await cursor.update({ ...r, user_id: meta.value, synced: false });
      cursor = await cursor.continue();
    }
    await tx.done;
  }
  const userId = meta.value;

  async function patch(id: string, fields: Partial<PendingCapture>): Promise<void> {
    const tx = db.transaction(PENDING_STORE, "readwrite");
    const r = (await tx.store.get(id)) as PendingCapture | undefined;
    if (r) await tx.store.put({ ...r, ...fields, user_id: r.user_id ?? userId, synced: false });
    await tx.done;
  }

  return {
    async put(record) {
      await db.put(PENDING_STORE, { ...record, user_id: record.user_id ?? userId });
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
    async listByStatus(status) {
      const all = (await db.getAllFromIndex(
        PENDING_STORE,
        "by_status",
        status,
      )) as PendingCapture[];
      return all.sort((a, b) => b.captured_at - a.captured_at);
    },
    async tag(id, opts) {
      await patch(id, {
        status: "tagged",
        topic_tags: opts.topic_tags,
        importance: opts.importance ?? "normal",
        tagged_at: now(),
      });
    },
    async dismiss(id) {
      await patch(id, { status: "dismissed" });
    },
    async restore(id) {
      await patch(id, { status: "pending" });
    },
    async listDistinctTags() {
      const tagged = (await db.getAllFromIndex(
        PENDING_STORE,
        "by_status",
        "tagged",
      )) as PendingCapture[];
      const set = new Set<string>();
      for (const r of tagged) for (const t of r.topic_tags ?? []) set.add(t);
      return [...set].sort();
    },
  };
}
