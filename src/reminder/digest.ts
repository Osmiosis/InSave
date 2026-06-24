import type { PendingCapture, UserSettings } from "../types";
import { DAY } from "./spacing";

export const DIGEST_CAP = 5;
export const CADENCE_GAP: Record<UserSettings["cadence"], number> = {
  often: 1 * DAY,
  balanced: 2 * DAY,
  rarely: 4 * DAY,
};

export function selectDue(
  items: PendingCapture[],
  settings: UserSettings,
  now: number,
): PendingCapture[] {
  if (settings.reminders_paused) return [];
  const rank = (i: PendingCapture) => (i.importance === "matters" ? 0 : 1);
  return items
    .filter((i) => i.reminder_status === "active" && (i.next_due_at ?? Infinity) <= now)
    .sort((a, b) => rank(a) - rank(b) || (a.next_due_at ?? 0) - (b.next_due_at ?? 0))
    .slice(0, DIGEST_CAP);
}

export function localHour(tz: string, now: number): number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false });
  return Number(f.format(new Date(now))) % 24;
}

export function isQuietHours(settings: UserSettings, now: number): boolean {
  const h = localHour(settings.timezone, now);
  const { quiet_start: a, quiet_end: b } = settings;
  return a <= b ? h >= a && h < b : h >= a || h < b;
}

export function cadenceGate(settings: UserSettings, now: number, hasMatters: boolean): boolean {
  if (settings.last_digest_at == null) return true;
  const gap = hasMatters ? CADENCE_GAP.often : CADENCE_GAP[settings.cadence];
  return now - settings.last_digest_at >= gap;
}
