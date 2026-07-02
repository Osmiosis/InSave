import { describe, it, expect } from "vitest";
import { toBind } from "../worker/index";
import { UPSERT_SQL } from "../worker/sql";

function wire(over: Record<string, unknown> = {}) {
  return {
    id: "id-1",
    canonical_url: "https://www.instagram.com/reel/A",
    raw_payload: "{}",
    captured_at: 1000,
    source: "import",
    status: "tagged",
    parse_ok: true,
    ...over,
  } as never;
}

describe("worker sync upsert", () => {
  it("serializes topic_tags to a JSON string", () => {
    expect(toBind(wire({ topic_tags: ["gym", "claude tricks"] }))[11]).toBe('["gym","claude tricks"]');
  });

  it("binds null for absent optional columns", () => {
    const b = toBind(wire());
    expect(b[11]).toBeNull(); // topic_tags
    expect(b[12]).toBeNull(); // importance
    expect(b[13]).toBeNull(); // tagged_at
    expect(b[14]).toBeNull(); // author
    expect(b[15]).toBeNull(); // media_type
  });

  it("maps parse_ok boolean to 1/0", () => {
    expect(toBind(wire({ parse_ok: true }))[6]).toBe(1);
    expect(toBind(wire({ parse_ok: false }))[6]).toBe(0);
  });

  it("upserts mutable columns on id conflict but never identity columns", () => {
    expect(UPSERT_SQL).toContain("ON CONFLICT(id) DO UPDATE SET");
    for (const col of ["status", "topic_tags", "importance", "tagged_at", "author", "media_type", "description", "saved_at"]) {
      expect(UPSERT_SQL).toContain(`${col} = excluded.${col}`);
    }
    const updateClause = UPSERT_SQL.slice(UPSERT_SQL.indexOf("DO UPDATE SET"));
    for (const col of ["canonical_url", "raw_payload", "captured_at", "source", "parse_ok"]) {
      expect(updateClause).not.toContain(`${col} = excluded.${col}`);
    }
  });

  it("carries user_id as a device-owned column", () => {
    expect(UPSERT_SQL).toContain("user_id = excluded.user_id");
    expect(toBind(wire({ user_id: "u1" }))[16]).toBe("u1");
  });

  it("never writes server-owned reminder-state columns from the device path", () => {
    for (const col of ["reminder_status", "next_due_at", "cycle_count", "ignored_count", "last_surfaced_at"]) {
      expect(UPSERT_SQL).not.toContain(col);
    }
  });

  it("carries collection_id as a device-owned content column", () => {
    expect(UPSERT_SQL).toContain("collection_id = excluded.collection_id");
    expect(toBind(wire({ collection_id: "col-x" }))[17]).toBe("col-x");
  });

  it("binds null when collection_id is absent (null-is-Saved)", () => {
    expect(toBind(wire())[17]).toBeNull();
  });

  it("carries deadline_at as a device-owned content column", () => {
    expect(UPSERT_SQL).toContain("deadline_at = excluded.deadline_at");
    expect(toBind(wire({ deadline_at: 1717 }))[18]).toBe(1717);
  });
  it("binds null when deadline_at is absent", () => {
    expect(toBind(wire())[18]).toBeNull();
  });
});
