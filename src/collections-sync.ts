import type { Collection } from "./types";

interface SyncableCollections {
  listUnsynced(): Promise<Collection[]>;
  markSynced(ids: string[]): Promise<void>;
}

// Drop the local-only `synced` flag before sending.
function toWire(c: Collection) {
  const { synced, ...wire } = c;
  void synced;
  return wire;
}

export async function drainCollections(
  store: SyncableCollections,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const unsynced = await store.listUnsynced();
  if (unsynced.length === 0) return;

  let res: Response;
  try {
    res = await fetchFn("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(unsynced.map(toWire)),
    });
  } catch {
    return; // offline — retry next trigger
  }
  if (!res.ok) return;

  let accepted: string[];
  try {
    accepted = ((await res.json()) as { accepted: string[] }).accepted ?? [];
  } catch {
    return;
  }
  if (accepted.length) await store.markSynced(accepted);
}
