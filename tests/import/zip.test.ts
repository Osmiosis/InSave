import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { extractSavedPostsJson } from "../../src/import/zip";
import { ImportError } from "../../src/import/errors";

const JSON_TEXT = JSON.stringify({ saved_saved_media: [{ title: "x" }] });

describe("extractSavedPostsJson", () => {
  it("returns the text unchanged when given a plain JSON blob", async () => {
    const blob = new Blob([strToU8(JSON_TEXT)]);
    const text = await extractSavedPostsJson(blob);
    expect(JSON.parse(text)).toHaveProperty("saved_saved_media");
  });

  it("locates and extracts a nested saved_posts.json from a zip", async () => {
    const zipped = zipSync({
      "your_instagram_activity/saved/saved_posts.json": strToU8(JSON_TEXT),
    });
    const blob = new Blob([zipped]);
    const text = await extractSavedPostsJson(blob);
    expect(JSON.parse(text)).toHaveProperty("saved_saved_media");
  });

  it("throws ImportError for a zip with no saved_posts.json", async () => {
    const zipped = zipSync({ "other/file.txt": strToU8("hello") });
    const blob = new Blob([zipped]);
    await expect(extractSavedPostsJson(blob)).rejects.toThrow(ImportError);
  });
});
