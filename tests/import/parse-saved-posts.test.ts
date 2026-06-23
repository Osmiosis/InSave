import { describe, it, expect } from "vitest";
import { parseSavedPosts } from "../../src/import/parse-saved-posts";
import { ImportError } from "../../src/import/errors";

const reelEntry = {
  timestamp: 1734200000, // Dec 2024, seconds
  media: [],
  label_values: [
    { label: "URL", value: "https://www.instagram.com/reel/DZZSfMqu6WY/", href: "https://www.instagram.com/reel/DZZSfMqu6WY/" },
    { label: "Caption", value: "Problems nobody solved yet, part 3" },
    { label: "Title", value: "" },
    { dict: [], title: "Hashtags" },
    { title: "Owner", dict: [ { title: "", dict: [
      { label: "URL", value: "https://gotaprob.beehiiv.com" },
      { label: "Name", value: "Idea Guy" },
      { label: "Username", value: "iamideaguy" },
    ] } ] },
  ],
  fbid: "18056521565574781",
};

const postNoCaption = {
  timestamp: 1734300000,
  label_values: [
    { label: "URL", value: "https://www.instagram.com/p/CymPostId/" },
    { title: "Owner", dict: [ { title: "", dict: [
      { label: "Username", value: "postcreator" },
    ] } ] },
  ],
};

const reelNoOwner = {
  timestamp: 1734400000,
  label_values: [
    { label: "URL", value: "https://www.instagram.com/reel/NoOwner1/" },
    { label: "Caption", value: "anon clip" },
  ],
};

describe("parseSavedPosts", () => {
  it("parses a real top-level array: url, username, caption, media type, seconds->ms", () => {
    const items = parseSavedPosts(JSON.stringify([reelEntry, postNoCaption, reelNoOwner]));
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      url: "https://www.instagram.com/reel/DZZSfMqu6WY/",
      author: "iamideaguy",
      savedAt: 1734200000000,
      caption: "Problems nobody solved yet, part 3",
      mediaType: "reel",
    });
  });

  it("handles posts (/p/) and a missing caption", () => {
    const items = parseSavedPosts(JSON.stringify([postNoCaption]));
    expect(items[0].mediaType).toBe("post");
    expect(items[0].author).toBe("postcreator");
    expect(items[0].caption).toBeUndefined();
  });

  it("tolerates a missing Owner (author empty, not fatal)", () => {
    const items = parseSavedPosts(JSON.stringify([reelNoOwner]));
    expect(items[0].author).toBe("");
    expect(items[0].caption).toBe("anon clip");
  });

  it("tolerates a legacy wrapper object around the array", () => {
    const items = parseSavedPosts(JSON.stringify({ saved_saved_media: [reelEntry] }));
    expect(items).toHaveLength(1);
    expect(items[0].author).toBe("iamideaguy");
  });

  it("throws ImportError on invalid JSON", () => {
    expect(() => parseSavedPosts("{not json")).toThrow(ImportError);
  });

  it("throws ImportError when the shape is neither array nor known wrapper", () => {
    expect(() => parseSavedPosts(JSON.stringify({ something_else: [] }))).toThrow(ImportError);
  });

  it("throws ImportError when there are zero entries", () => {
    expect(() => parseSavedPosts(JSON.stringify([]))).toThrow(ImportError);
  });
});
