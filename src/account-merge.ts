// Post-sign-in reconciliation (PRD 08 §7.1, Task 2.6). When the user is signed
// in but the device still holds an anonymous id, absorb this device's data into
// the account (/api/merge), swap the stored id to the account id, then re-pull
// the account library. Runs on load; safe to run every time — once swapped, the
// local id equals the account id and it no-ops.
import { getSession } from "./auth-client";
import { getUserId, setUserId } from "./db";
import { pullAndReconcile } from "./reminder-pull";

export interface ReconcileDeps {
  getSession: () => Promise<{ user: { id: string } } | null>;
  getLocalId: () => Promise<string>;
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
  await deps.setLocalId(session.user.id);
  await deps.refresh();
  return "merged";
}

function realDeps(): ReconcileDeps {
  return {
    getSession,
    getLocalId: () => getUserId(),
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
    refresh: () => pullAndReconcile(),
  };
}

if (typeof window !== "undefined") void reconcileAccount(realDeps());
