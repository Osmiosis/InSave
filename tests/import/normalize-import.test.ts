import { describe, it, expect } from "vitest";
import { toImportedItems } from "../../src/import/normalize-import";
import type { ParsedSavedItem } from "../../src/types";

let n = 0;
const deps = { now: () => 5000, uuid: () => `id-${n++}` };

function parsed(
  url: string,
  author = "a",
  savedAt = 1,
  over: Partial<ParsedSavedItem> = {},
): ParsedSavedItem {
  return { url, author, savedAt, mediaType: "reel", ...over };
}

describe("toImportedItems", () => {
  it("canonicalizes and marks parse_ok for a valid reel", () => {
    n = 0;
    const out = toImportedItems([parsed("https://www.instagram.com/reel/AAA/?igsh=x")], deps);
    expect(out).toHaveLength(1);
    expect(out[0].canonical_url).toBe("https://www.instagram.com/reel/AAA");
    expect(out[0].parse_ok).toBe(true);
    expect(out[0].backlog_state).toBe("dormant");
    expect(out[0].imported_at).toBe(5000);
  });

  it("collapses two share-variants of the same reel within the batch", () => {
    n = 0;
    const out = toImportedItems(
      [
        parsed("https://www.instagram.com/reel/AAA/?igsh=x"),
        parsed("https://instagram.com/reel/AAA"),
      ],
      deps,
    );
    expect(out).toHaveLength(1);
  });

  it("keeps an unparseable url as parse_ok=false (never dropped)", () => {
    n = 0;
    const out = toImportedItems([parsed("not a url")], deps);
    expect(out).toHaveLength(1);
    expect(out[0].parse_ok).toBe(false);
    expect(out[0].canonical_url).toBe("");
  });

  it("carries caption and media_type onto the imported item", () => {
    n = 0;
    const out = toImportedItems(
      [parsed("https://www.instagram.com/p/AAA/", "a", 1, { caption: "hi", mediaType: "post" })],
      deps,
    );
    expect(out[0].caption).toBe("hi");
    expect(out[0].media_type).toBe("post");
  });
});
