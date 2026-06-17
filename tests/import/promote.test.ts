import { describe, it, expect, vi } from "vitest";
import { promote } from "../../src/import/promote";
import type { ImportedItem, PendingCapture } from "../../src/types";

function item(): ImportedItem {
  return {
    id: "i-1", canonical_url: "https://www.instagram.com/reel/A", author: "a",
    saved_at: 1000, imported_at: 2000, raw_payload: '{"x":1}', parse_ok: true,
    backlog_state: "dormant",
  };
}

function deps() {
  const setState = vi.fn(async () => {});
  const put = vi.fn(async (_r: PendingCapture) => {});
  const enrich = vi.fn(async () => null);
  const drain = vi.fn(() => {});
  return {
    setState, put, enrich, drain,
    obj: {
      importedStore: { setState, bulkPut: async () => {}, getByCanonicalUrl: async () => undefined, listAll: async () => [], listByState: async () => [] },
      pendingStore: { put, getByCanonicalUrl: async () => undefined, listUnsynced: async () => [], markSynced: async () => {} },
      enricher: { enrich },
      drain,
      uuid: () => "new-id",
    },
  };
}

describe("promote", () => {
  it("flips state, writes a source=import pending record, enriches, and drains", async () => {
    const d = deps();
    await promote(item(), d.obj);

    expect(d.setState).toHaveBeenCalledWith("i-1", "promoted");
    expect(d.enrich).toHaveBeenCalledWith("https://www.instagram.com/reel/A");
    expect(d.drain).toHaveBeenCalledOnce();
    expect(d.put).toHaveBeenCalledOnce();

    const rec = d.put.mock.calls[0][0];
    expect(rec.source).toBe("import");
    expect(rec.status).toBe("pending");
    expect(rec.synced).toBe(false);
    expect(rec.saved_at).toBe(1000);
    expect(rec.canonical_url).toBe("https://www.instagram.com/reel/A");
    expect(rec.captured_at).toBe(2000); // imported_at
  });

  it("merges enrichment fields when the enricher returns them", async () => {
    const d = deps();
    d.enrich.mockResolvedValueOnce({ title: "T", thumbnail: "th" } as never);
    await promote(item(), d.obj);
    const rec = d.put.mock.calls[0][0];
    expect(rec.title).toBe("T");
    expect(rec.thumbnail).toBe("th");
  });
});
