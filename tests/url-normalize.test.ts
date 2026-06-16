import { describe, it, expect } from "vitest";
import { extractReelUrl, canonicalize, parse } from "../src/url-normalize";

describe("extractReelUrl", () => {
  it("returns the url field when it is an instagram reel", () => {
    expect(extractReelUrl({ url: "https://www.instagram.com/reel/ABC123/" }))
      .toBe("https://www.instagram.com/reel/ABC123/");
  });

  it("recovers a reel url embedded in the text field", () => {
    expect(extractReelUrl({ text: "Check this https://www.instagram.com/reel/ABC123/?igsh=xyz out" }))
      .toBe("https://www.instagram.com/reel/ABC123/?igsh=xyz");
  });

  it("recovers a share-link variant (instagram.com/reels/)", () => {
    expect(extractReelUrl({ text: "https://instagram.com/reels/ABC123" }))
      .toBe("https://instagram.com/reels/ABC123");
  });

  it("returns null when no instagram url is present", () => {
    expect(extractReelUrl({ text: "just some words", title: "nope" })).toBeNull();
  });
});

describe("canonicalize", () => {
  it("strips tracking params and trailing slash differences to one key", () => {
    const a = canonicalize("https://www.instagram.com/reel/ABC123/?igsh=xyz&utm_source=ig");
    const b = canonicalize("https://instagram.com/reel/ABC123");
    expect(a).toBe(b);
  });

  it("normalizes /reels/ variant to /reel/", () => {
    expect(canonicalize("https://www.instagram.com/reels/ABC123/"))
      .toBe("https://www.instagram.com/reel/ABC123");
  });
});

describe("parse", () => {
  it("returns canonical url and parseOk=true for a valid reel", () => {
    expect(parse({ url: "https://www.instagram.com/reel/ABC123/?igsh=x" }))
      .toEqual({ canonicalUrl: "https://www.instagram.com/reel/ABC123", parseOk: true });
  });

  it("returns parseOk=false and empty canonical url when nothing usable", () => {
    expect(parse({ text: "garbage" })).toEqual({ canonicalUrl: "", parseOk: false });
  });
});
