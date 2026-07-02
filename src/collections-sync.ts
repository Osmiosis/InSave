import { getUserId } from "./db";
import type { Collection } from "./types";

interface SyncableCollections {
  listUnsynced(): Promise<Collection[]>;
  markSynced(ids: string[]): Promise<void>;
}

interface PullableCollections {
  reconcilePulled(serverCols: Array<Omit<Collection, "synced">>): Promise<void>;
}

// Pull the owner's collections from D1 and mirror them into the local store
// (upsert present, delete synced-but-removed). Needed after an account merge so
// a signed-in device sees collections from other devices AND drops locals the
// server dropped (e.g. a collapsed duplicate default). When signed in the server
// keys on the session, so the query param is ignored. A failed fetch is a no-op
// (never mirror an empty set on error — that would wrongly delete everything).
export async function pullCollections(
  store: PullableCollections,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn(`/api/collections?user_id=${encodeURIComponent(await getUserId())}`);
  } catch {
    return; // offline — retry next trigger
  }
  if (!res.ok) return;

  let collections: Array<Omit<Collection, "synced">>;
  try {
    collections = ((await res.json()) as { collections: Array<Omit<Collection, "synced">> }).collections ?? [];
  } catch {
    return;
  }
  await store.reconcilePulled(collections);
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
