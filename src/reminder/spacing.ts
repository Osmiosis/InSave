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

export function presetFor(importance: unknown): Preset {
  return PRESETS[normalizeImportance(importance)];
}

export interface ReminderState {
  reminder_status: ReminderStatus;
  next_due_at: number;
  cycle_count: number;
  ignored_count: number;
}

export function initialState(importance: unknown, now: number): ReminderState {
  return {
    reminder_status: "active",
    cycle_count: 0,
    ignored_count: 0,
    next_due_at: now + presetFor(importance).initialDelay,
  };
}

// The "surfaced, not yet acted upon" scheduling transition. Interval and lifespan
// depend only on the importance preset and cycle — ignoring a reminder no longer
// stretches the gap or shortens the horizon (dropped per the 2026-07 tuning). The
// ignored_count signal is still tracked (see markIgnored in response.ts) but no
// longer feeds scheduling.
export function advance(
  item: PendingCapture,
  now: number,
): { reminder_status: ReminderStatus; next_due_at: number; cycle_count: number; last_surfaced_at: number } {
  const p = presetFor(item.importance);
  const cycle = item.cycle_count ?? 0;
  const interval = p.initialDelay * Math.pow(p.growth, cycle);
  const nextCycle = cycle + 1;
  const loopEntry = item.tagged_at ?? item.captured_at;
  const expired = nextCycle > p.maxCycles || now - loopEntry > p.maxAge;
  const deadlineActive = item.deadline_at != null && item.deadline_at > now;
  return {
    reminder_status: deadlineActive ? "active" : (expired ? "expired" : "active"),
    next_due_at: now + interval,
    cycle_count: nextCycle,
    last_surfaced_at: now,
  };
}
