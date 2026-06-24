import type { PendingCapture, UserSettings } from "../src/types";

export interface ReminderRepo {
  listTagged(): Promise<PendingCapture[]>;
  getSettings(userId: string): Promise<UserSettings | undefined>;
  putSettings(settings: UserSettings): Promise<void>;
  writeReminderState(id: string, fields: Partial<PendingCapture>): Promise<void>;
}

export function defaultSettings(userId: string, timezone = "UTC"): UserSettings {
  return {
    user_id: userId,
    quiet_start: 22,
    quiet_end: 8,
    timezone,
    cadence: "balanced",
    reminders_paused: false,
    synced: true,
  };
}
