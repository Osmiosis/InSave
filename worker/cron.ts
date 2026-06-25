import type { PendingCapture } from "../src/types";
import { initialState, advance, normalizeImportance } from "../src/reminder/spacing";
import { markIgnored } from "../src/reminder/response";
import { selectDue, isQuietHours, cadenceGate } from "../src/reminder/digest";
import { defaultSettings, type ReminderRepo } from "./reminder-repo";

export type Notify = (userId: string, due: PendingCapture[]) => Promise<void>;

const HOUR = 3_600_000;

export async function runCron(repo: ReminderRepo, now: number, notify: Notify): Promise<void> {
  const cycleStart = Math.floor(now / HOUR) * HOUR;

  const byUser = new Map<string, PendingCapture[]>();
  for (const it of await repo.listTagged()) {
    if (!it.user_id) continue;
    const list = byUser.get(it.user_id) ?? [];
    list.push(it);
    byUser.set(it.user_id, list);
  }

  for (const [userId, items] of byUser) {
    // 1. Lazy-init freshly tagged items into the loop.
    for (const it of items) {
      if (!it.reminder_status) {
        const seed = initialState(it.importance, now, it.deadline_at);
        Object.assign(it, seed);
        await repo.writeReminderState(it.id, seed);
      }
    }

    // 2. Load (or create) settings; honor pause + quiet hours.
    let settings = await repo.getSettings(userId);
    if (!settings) {
      settings = defaultSettings(userId);
      await repo.putSettings(settings);
    }
    if (settings.reminders_paused || isQuietHours(settings, now)) continue;

    // 3. Select due items; gate on cadence (high can pull forward).
    const due = selectDue(items, settings, now);
    if (due.length === 0) continue;
    const hasHigh = due.some((d) => normalizeImportance(d.importance) === "high");
    if (!cadenceGate(settings, now, hasHigh)) continue;

    // 4. Advance each surfaced item (idempotency guard), then notify.
    for (const it of due) {
      if ((it.last_surfaced_at ?? 0) >= cycleStart) continue;
      const fields = { ...advance(it, now), ignored_count: markIgnored(it).ignored_count };
      Object.assign(it, fields);
      await repo.writeReminderState(it.id, fields);
    }
    await notify(userId, due);
    await repo.putSettings({ ...settings, last_digest_at: now });
  }
}
