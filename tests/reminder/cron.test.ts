import { describe, it, expect } from "vitest";
import { runCron } from "../../worker/cron";
import { defaultSettings, type ReminderRepo } from "../../worker/reminder-repo";
import { PRESETS, DAY } from "../../src/reminder/spacing";
import type { PendingCapture, UserSettings } from "../../src/types";

function item(over: Partial<PendingCapture>): PendingCapture {
  return {
    id: "i", canonical_url: "u", raw_payload: "{}", captured_at: 0,
    source: "import", status: "tagged", parse_ok: true, synced: true,
    user_id: "u1", importance: "normal", tagged_at: 0, ...over,
  };
}

function fakeRepo(items: PendingCapture[], settings: UserSettings[] = []) {
  const itemMap = new Map(items.map((i) => [i.id, i]));
  const settingMap = new Map(settings.map((s) => [s.user_id, s]));
  const repo: ReminderRepo = {
    async listTagged() { return [...itemMap.values()]; },
    async getSettings(u) { return settingMap.get(u); },
    async putSettings(s) { settingMap.set(s.user_id, s); },
    async writeReminderState(id, f) { Object.assign(itemMap.get(id)!, f); },
    async putSubscription() {},
    async listSubscriptions() { return []; },
    async deleteSubscription() {},
    async listByUser() { return []; },
    async getById() { return undefined; },
  };
  return { repo, itemMap, settingMap };
}

function capturingNotify() {
  const sent: { userId: string; ids: string[] }[] = [];
  return { sent, notify: async (userId: string, due: PendingCapture[]) => { sent.push({ userId, ids: due.map((d) => d.id) }); } };
}

const NOON = Date.UTC(2026, 0, 1, 12, 0, 0);
const neverQuiet = (over: Partial<UserSettings> = {}): UserSettings =>
  ({ ...defaultSettings("u1", "UTC"), quiet_start: 0, quiet_end: 0, ...over });

describe("runCron", () => {
  it("lazy-initializes a freshly tagged item (no reminder_status) without surfacing it", async () => {
    const { repo, itemMap } = fakeRepo([item({ id: "a", reminder_status: undefined })], [neverQuiet()]);
    const { sent, notify } = capturingNotify();
    await runCron(repo, NOON, notify);
    const a = itemMap.get("a")!;
    expect(a.reminder_status).toBe("active");
    expect(a.next_due_at).toBe(NOON + PRESETS.normal.initialDelay); // due in the future
    expect(sent).toEqual([]); // not surfaced this cycle
  });

  it("surfaces a due active item, advances it, and notifies", async () => {
    const { repo, itemMap } = fakeRepo(
      [item({ id: "a", reminder_status: "active", cycle_count: 0, ignored_count: 0, next_due_at: NOON - DAY })],
      [neverQuiet()],
    );
    const { sent, notify } = capturingNotify();
    await runCron(repo, NOON, notify);
    expect(sent).toEqual([{ userId: "u1", ids: ["a"] }]);
    const a = itemMap.get("a")!;
    expect(a.cycle_count).toBe(1);
    expect(a.ignored_count).toBe(1); // surfaced-but-unacted
    expect(a.next_due_at).toBeGreaterThan(NOON);
    expect(a.last_surfaced_at).toBe(NOON);
  });

  it("holds during quiet hours (no notify, no advance)", async () => {
    const quiet = { ...defaultSettings("u1", "UTC"), quiet_start: 0, quiet_end: 23 }; // 12:00 is quiet
    const { repo, itemMap } = fakeRepo(
      [item({ id: "a", reminder_status: "active", cycle_count: 0, next_due_at: NOON - DAY })], [quiet],
    );
    const { sent, notify } = capturingNotify();
    await runCron(repo, NOON, notify);
    expect(sent).toEqual([]);
    expect(itemMap.get("a")!.cycle_count).toBe(0);
  });

  it("does not notify when reminders are paused", async () => {
    const { repo } = fakeRepo(
      [item({ id: "a", reminder_status: "active", next_due_at: NOON - DAY })],
      [neverQuiet({ reminders_paused: true })],
    );
    const { sent, notify } = capturingNotify();
    await runCron(repo, NOON, notify);
    expect(sent).toEqual([]);
  });

  it("respects the cadence gate (recent digest blocks the next)", async () => {
    const { repo } = fakeRepo(
      [item({ id: "a", reminder_status: "active", next_due_at: NOON - DAY })],
      [neverQuiet({ last_digest_at: NOON - 1000 })], // far within the balanced gap
    );
    const { sent, notify } = capturingNotify();
    await runCron(repo, NOON, notify);
    expect(sent).toEqual([]);
  });

  it("creates default settings when a user has none", async () => {
    const { repo, settingMap } = fakeRepo([item({ id: "a", reminder_status: "active", next_due_at: NOON - DAY })]);
    const { notify } = capturingNotify();
    await runCron(repo, NOON, notify);
    expect(settingMap.get("u1")).toBeDefined();
  });

  it("is idempotent on a double run in the same cycle (no double advance or double send)", async () => {
    const { repo, itemMap } = fakeRepo(
      [item({ id: "a", reminder_status: "active", cycle_count: 0, next_due_at: NOON - DAY })],
      [neverQuiet()],
    );
    const { sent, notify } = capturingNotify();
    await runCron(repo, NOON, notify);
    await runCron(repo, NOON, notify);
    expect(sent).toHaveLength(1);
    expect(itemMap.get("a")!.cycle_count).toBe(1);
  });

  it("surfaces a past-next_due item immediately despite a future deadline (sooner is fine)", async () => {
    const { repo } = fakeRepo(
      [item({ id: "d", reminder_status: "active", cycle_count: 0, next_due_at: NOON - DAY, deadline_at: NOON + 10 * DAY })],
      [neverQuiet()],
    );
    const { sent, notify } = capturingNotify();
    await runCron(repo, NOON, notify);
    expect(sent).toEqual([{ userId: "u1", ids: ["d"] }]); // not held until the deadline
  });

  it("surfaces a reached-deadline item and bypasses the cadence gate", async () => {
    const recent = { ...neverQuiet(), last_digest_at: NOON - 3_600_000 }; // 1h ago; balanced gap 2d → cadence would block
    const { repo, itemMap } = fakeRepo(
      [item({ id: "d", reminder_status: "active", cycle_count: 0, next_due_at: NOON + 10 * DAY, deadline_at: NOON - DAY })],
      [recent],
    );
    const { sent, notify } = capturingNotify();
    await runCron(repo, NOON, notify);
    expect(sent).toEqual([{ userId: "u1", ids: ["d"] }]);
    expect(itemMap.get("d")!.last_surfaced_at).toBe(NOON);
  });

  it("still blocks a non-deadline due item under the cadence gate (bypass is deadline-only)", async () => {
    const recent = { ...neverQuiet(), last_digest_at: NOON - 3_600_000 }; // 1h ago
    const { repo } = fakeRepo(
      [item({ id: "a", reminder_status: "active", cycle_count: 0, next_due_at: NOON - DAY })], // due, no deadline
      [recent],
    );
    const { sent, notify } = capturingNotify();
    await runCron(repo, NOON, notify);
    expect(sent).toEqual([]); // cadence still gates a plain due item
  });

  it("surfaces a reached-deadline item exactly once across consecutive ticks", async () => {
    const { repo } = fakeRepo(
      [item({ id: "d", reminder_status: "active", cycle_count: 0, next_due_at: NOON + 10 * DAY, deadline_at: NOON - DAY })],
      [neverQuiet()],
    );
    const { sent, notify } = capturingNotify();
    await runCron(repo, NOON, notify);            // tick 1: surfaces (last_surfaced = NOON)
    await runCron(repo, NOON + DAY, notify);        // tick 2: last_surfaced(NOON) >= deadline(NOON-DAY) → not re-selected
    expect(sent).toEqual([{ userId: "u1", ids: ["d"] }]);
  });

  it("does not surface a reached-deadline item during quiet hours; surfaces once quiet ends", async () => {
    const quiet = { ...defaultSettings("u1", "UTC"), quiet_start: 0, quiet_end: 23 }; // 12:00 quiet, 23:00 not
    const { repo, itemMap } = fakeRepo(
      [item({ id: "d", reminder_status: "active", cycle_count: 0, next_due_at: NOON + 10 * DAY, deadline_at: NOON - DAY })],
      [quiet],
    );
    const capA = capturingNotify();
    await runCron(repo, NOON, capA.notify);          // quiet → suppressed
    expect(capA.sent).toEqual([]);
    expect(itemMap.get("d")!.last_surfaced_at).toBeUndefined();

    const nonQuiet = Date.UTC(2026, 0, 1, 23, 0, 0);
    const capB = capturingNotify();
    await runCron(repo, nonQuiet, capB.notify);      // still unserviced → surfaces
    expect(capB.sent).toEqual([{ userId: "u1", ids: ["d"] }]);
  });

});
