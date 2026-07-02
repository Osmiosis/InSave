// Server->device pull for signed-in users. When signed in, pull the account's
// collections + reels so this device stays current with saves made on other
// devices. No-op when signed out — the anonymous fast path never pulls.
import { getSession } from "./auth-client";
import { pullCollections } from "./collections-sync";
import { pullAndReconcile } from "./reminder-pull";
import type { Collection } from "./types";

export interface SyncDownDeps {
  getSession: () => Promise<unknown | null>;
  pullCollections: (store: { upsertPulled(c: Omit<Collection, "synced">): Promise<void> }) => Promise<void>;
  pullReels: () => Promise<void>;
}

export async function syncDownIfSignedIn(
  store: { upsertPulled(c: Omit<Collection, "synced">): Promise<void> },
  deps: SyncDownDeps = { getSession, pullCollections, pullReels: pullAndReconcile },
): Promise<boolean> {
  const session = await deps.getSession();
  if (!session) return false;
  await deps.pullCollections(store);
  await deps.pullReels();
  return true;
}
