import { describe, it, expect } from "vitest";
import { mergePulled } from "../../src/reminder/reconcile-pull";
import type { PendingCapture } from "../../src/types";

function rec(over: Partial<PendingCapture>): PendingCapture {
  return {
    id: "a", canonical_url: "u", raw_payload: "{}", captured_at: 0,
    source: "import", status: "tagged", parse_ok: true, synced: true, ...over,
  };
}

describe("mergePulled", () => {
  it("inserts a remote-only record whole (reinstall restore)", () => {
    const remote = rec({ reminder_status: "active", next_due_at: 5, topic_tags: ["gym"] });
    expect(mergePulled(undefined, remote)).toEqual({ ...remote, synced: true });
  });

  it("overlays only the server-owned fields, keeping local device content", () => {
    const local = rec({ topic_tags: ["gym"], importance: "high", status: "tagged", reminder_status: "active", cycle_count: 1, synced: false });
    const remote = rec({ topic_tags: ["SERVER-WINS?"], importance: "normal", status: "dismissed", reminder_status: "expired", next_due_at: 99, cycle_count: 7, ignored_count: 2, last_surfaced_at: 50 });
    const merged = mergePulled(local, remote);
    // device-owned kept from local:
    expect(merged.topic_tags).toEqual(["gym"]);
    expect(merged.importance).toBe("high");
    expect(merged.status).toBe("tagged");
    expect(merged.synced).toBe(false);
    // server-owned taken from remote:
    expect(merged.reminder_status).toBe("expired");
    expect(merged.next_due_at).toBe(99);
    expect(merged.cycle_count).toBe(7);
    expect(merged.ignored_count).toBe(2);
    expect(merged.last_surfaced_at).toBe(50);
  });

  it("does not clobber a newer local collection_id on pull", () => {
    const local = rec({ collection_id: "col-local", reminder_status: "active", synced: false });
    const remote = rec({ collection_id: "col-stale-server", reminder_status: "expired", next_due_at: 99 });
    const merged = mergePulled(local, remote);
    expect(merged.collection_id).toBe("col-local"); // device-owned content kept
    expect(merged.reminder_status).toBe("expired"); // server-owned overlaid
  });

  it("restore (!local) carries collection_id from remote", () => {
    const remote = rec({ collection_id: "col-restored" });
    expect(mergePulled(undefined, remote).collection_id).toBe("col-restored");
  });
});
