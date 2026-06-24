import type { PendingCapture, ReminderStatus } from "../types";
import { presetFor } from "./spacing";

// User-action transitions. Pure field patches; the cron (and PRD 04b's review UI)
// merge the returned fields onto the item.

export function markDone(_item: PendingCapture): { reminder_status: ReminderStatus } {
  return { reminder_status: "done" };
}

export function snooze(
  item: PendingCapture,
  now: number,
): { next_due_at: number; reminder_status: ReminderStatus } {
  return { reminder_status: "active", next_due_at: now + presetFor(item.importance).initialDelay };
}

export function markOpened(_item: PendingCapture): { ignored_count: number } {
  return { ignored_count: 0 };
}

export function markIgnored(item: PendingCapture): { ignored_count: number } {
  return { ignored_count: (item.ignored_count ?? 0) + 1 };
}
