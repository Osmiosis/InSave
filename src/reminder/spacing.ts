import type { Importance, PendingCapture, ReminderStatus } from "../types";

export const DAY = 86_400_000;

export interface Preset {
  initialDelay: number;
  growth: number;
  maxCycles: number;
  maxAge: number;
}

export function normalizeImportance(raw: unknown): Importance {
  if (raw === "low" || raw === "normal" || raw === "high") return raw;
  if (raw === "matters") return "high"; // legacy PRD 03 value
  return "normal";                       // null / undefined / unknown
}

// Tuning values (PRD 06a §3.1) — expect to adjust against a real backlog.
export const PRESETS: Record<Importance, Preset> = {
  high:   { initialDelay: 1 * DAY, growth: 1.6, maxCycles: 8, maxAge: 90 * DAY }, // was "matters"
  normal: { initialDelay: 3 * DAY, growth: 2.0, maxCycles: 4, maxAge: 45 * DAY },
  low:    { initialDelay: 7 * DAY, growth: 2.5, maxCycles: 2, maxAge: 21 * DAY },
};

export const IGNORE_THRESHOLD = 2;
export const IGNORE_ACCEL = 1.5;

export function presetFor(importance: unknown): Preset {
  return PRESETS[normalizeImportance(importance)];
}

export interface ReminderState {
  reminder_status: ReminderStatus;
  next_due_at: number;
  cycle_count: number;
  ignored_count: number;
}

// A future deadline overrides tier spacing: the item is scheduled to the deadline
// and stays quiet until then. Once the deadline is past, tier spacing resumes.
export function effectiveNextDue(tierNextDue: number, deadline_at: number | undefined, now: number): number {
  return deadline_at != null && deadline_at > now ? deadline_at : tierNextDue;
}

export function initialState(importance: unknown, now: number, deadline_at?: number): ReminderState {
  return {
    reminder_status: "active",
    cycle_count: 0,
    ignored_count: 0,
    next_due_at: effectiveNextDue(now + presetFor(importance).initialDelay, deadline_at, now),
  };
}

// The "surfaced, not yet acted upon" scheduling transition. Reads ignored_count to
// decide whether back-off acceleration applies; does NOT itself change ignored_count
// (that is markIgnored's job — see response.ts — composed by the cron).
export function advance(
  item: PendingCapture,
  now: number,
): { reminder_status: ReminderStatus; next_due_at: number; cycle_count: number; last_surfaced_at: number } {
  const p = presetFor(item.importance);
  const cycle = item.cycle_count ?? 0;
  const accel = (item.ignored_count ?? 0) >= IGNORE_THRESHOLD ? IGNORE_ACCEL : 1;
  const interval = p.initialDelay * Math.pow(p.growth * accel, cycle);
  const nextCycle = cycle + 1;
  const loopEntry = item.tagged_at ?? item.captured_at;
  const ageHorizon = accel > 1 ? p.maxAge / 2 : p.maxAge; // ignore back-off lowers the horizon
  const expired = nextCycle > p.maxCycles || now - loopEntry > ageHorizon;
  const deadlineActive = item.deadline_at != null && item.deadline_at > now;
  return {
    reminder_status: deadlineActive ? "active" : (expired ? "expired" : "active"),
    next_due_at: effectiveNextDue(now + interval, item.deadline_at, now),
    cycle_count: nextCycle,
    last_surfaced_at: now,
  };
}
