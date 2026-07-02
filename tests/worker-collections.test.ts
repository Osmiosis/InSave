import { describe, it, expect } from "vitest";
import { parseCollections } from "../worker/index";
import { COLLECTIONS_UPSERT_SQL } from "../worker/sql";

describe("worker collections rail", () => {
  it("upserts mutable columns on id conflict but not identity columns", () => {
    expect(COLLECTIONS_UPSERT_SQL).toContain("ON CONFLICT(id) DO UPDATE SET");
    expect(COLLECTIONS_UPSERT_SQL).toContain("name = excluded.name");
    expect(COLLECTIONS_UPSERT_SQL).toContain("is_default = excluded.is_default");
    const update = COLLECTIONS_UPSERT_SQL.slice(COLLECTIONS_UPSERT_SQL.indexOf("DO UPDATE SET"));
    for (const col of ["id", "user_id", "created_at"]) {
      expect(update).not.toContain(`${col} = excluded.${col}`);
    }
  });

  it("parseCollections accepts a valid array and rejects junk", () => {
    const ok = parseCollections([
      { id: "a", user_id: "u", name: "Saved", created_at: 1, is_default: true },
    ]);
    expect(ok).toHaveLength(1);
    expect(parseCollections({})).toBeNull();
    expect(parseCollections([{ id: "a" }])).toBeNull(); // missing required fields
  });
});
