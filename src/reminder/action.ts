import type { PendingCapture } from "../types";
import { markDone, snooze, markOpened } from "./response";

export type ReminderAction = "done" | "snooze" | "open";

// Maps a user action to the server-owned reminder-state patch (reuses 04a response.ts).
export function applyAction(
  item: PendingCapture,
  action: ReminderAction,
  now: number,
): Partial<PendingCapture> {
  switch (action) {
    case "done":
      return markDone(item);
    case "snooze":
      return snooze(item, now);
    case "open":
      return markOpened(item);
  }
}
