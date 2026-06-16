import type { PendingCapture } from "./types";
import type { PendingStore } from "./pending-store";

// Fields sent to the backend (drop the local-only `synced` flag).
function toWire(r: PendingCapture) {
  const { synced, ...wire } = r;
  void synced;
  return wire;
}

export async function drainSync(
  store: PendingStore,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const unsynced = await store.listUnsynced();
  if (unsynced.length === 0) return;

  let res: Response;
  try {
    res = await fetchFn("/api/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(unsynced.map(toWire)),
    });
  } catch {
    return; // offline / unreachable — retry on next trigger
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
