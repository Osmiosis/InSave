import { drainSync } from "./sync";
import { drainCollections } from "./collections-sync";
import type { PendingStore } from "./pending-store";
import type { CollectionsStore } from "./collections-store";

// Runs both device-owned sync rails. Each is guarded so an offline/transient
// failure on one never blocks or propagates from the other (mirrors the
// fire-and-forget discipline of drainSync/drainCollections).
export async function drainAll(
  pending: PendingStore,
  collections: Pick<CollectionsStore, "listUnsynced" | "markSynced">,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  try { await drainSync(pending, fetchFn); } catch { /* retry next trigger */ }
  try { await drainCollections(collections, fetchFn); } catch { /* retry next trigger */ }
}
