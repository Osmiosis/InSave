import { openInsaveDB, PENDING_STORE, getUserId } from "./db";
import { mergePulled } from "./reminder/reconcile-pull";
import type { PendingCapture } from "./types";

// Pull the user's tracked items from D1 and reconcile into IndexedDB: server-owned
// reminder state overlays local; device-owned content is kept; unknown rows inserted.
export async function pullAndReconcile(fetchFn: typeof fetch = fetch): Promise<void> {
  const userId = await getUserId();
  let res: Response;
  try {
    res = await fetchFn(`/api/pull?user_id=${encodeURIComponent(userId)}`);
  } catch {
    return; // offline — try again next launch
  }
  if (!res.ok) return;

  let items: PendingCapture[];
  try {
    items = ((await res.json()) as { items: PendingCapture[] }).items ?? [];
  } catch {
    return;
  }

  const db = await openInsaveDB();
  const tx = db.transaction(PENDING_STORE, "readwrite");
  for (const remote of items) {
    const local = (await tx.store.get(remote.id)) as PendingCapture | undefined;
    await tx.store.put(mergePulled(local, remote));
  }
  await tx.done;
}
