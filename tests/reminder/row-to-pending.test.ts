import { describe, it, expect } from "vitest";
import { rowToPending } from "../../src/reminder/row-to-pending";

describe("rowToPending", () => {
  it("rehydrates a D1 row into a PendingCapture", () => {
    const p = rowToPending({
      id: "a", canonical_url: "u", raw_payload: "{}", captured_at: 10,
      source: "import", status: "tagged", parse_ok: 1,
      topic_tags: '["gym","skincare"]', importance: "matters", tagged_at: 20,
      author: "creator", media_type: "reel", user_id: "u1",
      reminder_status: "active", next_due_at: 30, cycle_count: 2, ignored_count: 0, last_surfaced_at: 25,
    });
    expect(p.parse_ok).toBe(true);
    expect(p.topic_tags).toEqual(["gym", "skincare"]);
    expect(p.synced).toBe(true);
    expect(p.reminder_status).toBe("active");
    expect(p.next_due_at).toBe(30);
    expect(p.user_id).toBe("u1");
  });

  it("normalizes nulls and a parse_ok of 0", () => {
    const p = rowToPending({
      id: "b", canonical_url: "", raw_payload: "{}", captured_at: 0,
      source: "share_target", status: "pending", parse_ok: 0,
      topic_tags: null, importance: null, author: null, media_type: null,
      reminder_status: null, next_due_at: null,
    });
    expect(p.parse_ok).toBe(false);
    expect(p.topic_tags).toBeUndefined();
    expect(p.importance).toBeUndefined();
    expect(p.reminder_status).toBeUndefined();
    expect(p.next_due_at).toBeUndefined();
  });

  it("maps collection_id from the row", () => {
    const p = rowToPending({ id: "a", canonical_url: "u", raw_payload: "{}", captured_at: 1, source: "import", status: "tagged", parse_ok: 1, collection_id: "col-x" });
    expect(p.collection_id).toBe("col-x");
  });

  it("leaves collection_id undefined when the column is null (null-is-Saved)", () => {
    const p = rowToPending({ id: "a", canonical_url: "u", raw_payload: "{}", captured_at: 1, source: "import", status: "tagged", parse_ok: 1, collection_id: null });
    expect(p.collection_id).toBeUndefined();
  });
});
