import { describe, it, expect } from "vitest";
import { parseSavedPosts } from "../../src/import/parse-saved-posts";
import { ImportError } from "../../src/import/errors";

const real = JSON.stringify({
  saved_saved_media: [
    {
      title: "creator_one",
      string_map_data: {
        "Saved on": { href: "https://www.instagram.com/reel/AAA/", timestamp: 1700000000 },
      },
    },
    {
      title: "creator_two",
      string_map_data: {
        "Saved on": { href: "https://www.instagram.com/reel/BBB/", timestamp: 1700000100 },
      },
    },
  ],
});

describe("parseSavedPosts", () => {
  it("extracts url, author and timestamp (seconds -> ms)", () => {
    const items = parseSavedPosts(real);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      url: "https://www.instagram.com/reel/AAA/",
      author: "creator_one",
      savedAt: 1700000000000,
      mediaType: "reel",
    });
  });

  it("falls back to the first string_map_data slot when 'Saved on' is absent", () => {
    const variant = JSON.stringify({
      saved_saved_media: [
        { title: "c", string_map_data: { "Added": { href: "https://www.instagram.com/reel/CCC/", timestamp: 5 } } },
      ],
    });
    const items = parseSavedPosts(variant);
    expect(items[0].url).toBe("https://www.instagram.com/reel/CCC/");
    expect(items[0].savedAt).toBe(5000);
  });

  it("throws ImportError on invalid JSON", () => {
    expect(() => parseSavedPosts("{not json")).toThrow(ImportError);
  });

  it("throws ImportError when saved_saved_media is missing", () => {
    expect(() => parseSavedPosts(JSON.stringify({ something_else: [] }))).toThrow(ImportError);
  });

  it("throws ImportError when there are zero parseable entries", () => {
    expect(() => parseSavedPosts(JSON.stringify({ saved_saved_media: [] }))).toThrow(ImportError);
  });
});
