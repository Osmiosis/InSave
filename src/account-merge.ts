// Post-sign-in reconciliation (PRD 08 §7, Task 2.6). When the user is signed in
// but the device still holds an anonymous id: absorb this device's data into the
// account (/api/merge), re-own the device's local rows to the account id, swap
// the stored id, then pull the account's collections + reels so other devices'
// data appears. Runs on load; once swapped the local id equals the account id
// and it no-ops.
import { getSession } from "./auth-client";
import { getUserId, setUserId, reownLocalData } from "./db";
import { pullAndReconcile } from "./reminder-pull";
import { pullCollections } from "./collections-sync";
import { createCollectionsStore } from "./collections-store";

export interface ReconcileDeps {
  getSession: () => Promise<{ user: { id: string } } | null>;
  getLocalId: () => Promise<string>;
  reown: (fromId: string, toId: string) => Promise<void>;
  setLocalId: (id: string) => Promise<void>;
  merge: (anonId: string) => Promise<boolean>;
  refresh: () => Promise<void>;
}

export async function reconcileAccount(
  deps: ReconcileDeps,
): Promise<"skipped" | "merged" | "failed"> {
  const session = await deps.getSession();
  if (!session) return "skipped";
  const localId = await deps.getLocalId();
  if (localId === session.user.id) return "skipped";

  const ok = await deps.merge(localId);
  if (!ok) return "failed"; // leave the local id as-is; retry on the next load
  await deps.reown(localId, session.user.id); // keep this device's own rows visible
  await deps.setLocalId(session.user.id);
  await deps.refresh(); // pull collections + reels from the account
  return "merged";
}

function realDeps(): ReconcileDeps {
  return {
    getSession,
    getLocalId: () => getUserId(),
    reown: (fromId, toId) => reownLocalData(fromId, toId),
    setLocalId: (id) => setUserId(id),
    merge: async (anonId) => {
      try {
        const res = await fetch("/api/merge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ anon_id: anonId }),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    refresh: async () => {
      const store = await createCollectionsStore();
      await pullCollections(store);
      await pullAndReconcile();
    },
  };
}

if (typeof window !== "undefined") {
  void reconcileAccount(realDeps()).then((result) => {
    // Re-render from the freshly reconciled local data.
    if (result === "merged") window.location.reload();
  });
}
