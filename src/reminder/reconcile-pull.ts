import type { PendingCapture } from "../types";

// Reconciliation rule: remote is authoritative for the five server-owned reminder columns;
// local keeps all device-owned content. A record with no local copy is inserted whole.
export function mergePulled(local: PendingCapture | undefined, remote: PendingCapture): PendingCapture {
  if (!local) return { ...remote, synced: true };
  return {
    ...local,
    reminder_status: remote.reminder_status,
    next_due_at: remote.next_due_at,
    cycle_count: remote.cycle_count,
    ignored_count: remote.ignored_count,
    last_surfaced_at: remote.last_surfaced_at,
  };
}
