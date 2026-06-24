import type { PendingCapture, UserSettings } from "../src/types";
import type { ReminderRepo } from "./reminder-repo";
import type { PushSubscriptionRecord } from "./push-sender";
import { rowToPending } from "../src/reminder/row-to-pending";

const REMINDER_COLS = [
  "reminder_status", "next_due_at", "cycle_count", "ignored_count", "last_surfaced_at",
] as const;

export function makeD1ReminderRepo(db: D1Database): ReminderRepo {
  return {
    async listTagged() {
      const { results } = await db
        .prepare(`SELECT * FROM pending_capture WHERE status = 'tagged'`)
        .all<PendingCapture>();
      return results ?? [];
    },

    async getSettings(userId) {
      const row = await db
        .prepare(`SELECT * FROM user_settings WHERE user_id = ?`)
        .bind(userId)
        .first<Record<string, unknown>>();
      if (!row) return undefined;
      return {
        user_id: row.user_id as string,
        quiet_start: row.quiet_start as number,
        quiet_end: row.quiet_end as number,
        timezone: row.timezone as string,
        cadence: row.cadence as UserSettings["cadence"],
        reminders_paused: Boolean(row.reminders_paused),
        last_digest_at: (row.last_digest_at as number) ?? undefined,
        synced: true,
      };
    },

    async putSettings(s) {
      await db
        .prepare(
          `INSERT INTO user_settings
             (user_id, quiet_start, quiet_end, timezone, cadence, reminders_paused, last_digest_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end,
             timezone = excluded.timezone, cadence = excluded.cadence,
             reminders_paused = excluded.reminders_paused, last_digest_at = excluded.last_digest_at`,
        )
        .bind(
          s.user_id, s.quiet_start, s.quiet_end, s.timezone, s.cadence,
          s.reminders_paused ? 1 : 0, s.last_digest_at ?? null,
        )
        .run();
    },

    async writeReminderState(id, fields) {
      const cols = REMINDER_COLS.filter((c) => c in fields);
      if (cols.length === 0) return;
      const set = cols.map((c) => `${c} = ?`).join(", ");
      await db
        .prepare(`UPDATE pending_capture SET ${set} WHERE id = ?`)
        .bind(...cols.map((c) => (fields as Record<string, unknown>)[c] ?? null), id)
        .run();
    },

    async putSubscription(sub) {
      await db
        .prepare(
          `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET
             user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
        )
        .bind(sub.endpoint, sub.user_id, sub.p256dh, sub.auth, sub.created_at)
        .run();
    },

    async listSubscriptions(userId) {
      const { results } = await db
        .prepare(`SELECT * FROM push_subscriptions WHERE user_id = ?`)
        .bind(userId)
        .all<PushSubscriptionRecord>();
      return results ?? [];
    },

    async deleteSubscription(endpoint) {
      await db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(endpoint).run();
    },

    async listByUser(userId) {
      const { results } = await db
        .prepare(`SELECT * FROM pending_capture WHERE user_id = ?`)
        .bind(userId)
        .all<Record<string, unknown>>();
      return (results ?? []).map(rowToPending);
    },

    async getById(id) {
      const row = await db
        .prepare(`SELECT * FROM pending_capture WHERE id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
      return row ? rowToPending(row) : undefined;
    },
  };
}
