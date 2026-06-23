import { openInsaveDB, PENDING_STORE } from "./db";
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
): Promise<PendingStore> {
  const db = await openInsaveDB();

  async function patch(id: string, fields: Partial<PendingCapture>): Promise<void> {
    const tx = db.transaction(PENDING_STORE, "readwrite");
    const r = (await tx.store.get(id)) as PendingCapture | undefined;
    if (r) await tx.store.put({ ...r, ...fields, synced: false });
    await tx.done;
  }

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
