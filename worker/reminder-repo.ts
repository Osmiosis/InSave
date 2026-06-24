import type { PendingCapture, UserSettings } from "../src/types";
import type { PushSubscriptionRecord } from "./push-sender";

export interface ReminderRepo {
  listTagged(): Promise<PendingCapture[]>;
  getSettings(userId: string): Promise<UserSettings | undefined>;
  putSettings(settings: UserSettings): Promise<void>;
  writeReminderState(id: string, fields: Partial<PendingCapture>): Promise<void>;
  putSubscription(sub: PushSubscriptionRecord): Promise<void>;
  listSubscriptions(userId: string): Promise<PushSubscriptionRecord[]>;
  deleteSubscription(endpoint: string): Promise<void>;
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
