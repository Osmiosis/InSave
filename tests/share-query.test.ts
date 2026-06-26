import { describe, it, expect } from "vitest";
import { payloadFromQuery } from "../src/share-query";

describe("payloadFromQuery", () => {
  it("decodes a u= param into the url field", () => {
    expect(payloadFromQuery("?u=https%3A%2F%2Fwww.instagram.com%2Freel%2FABC")).toEqual({
      url: "https://www.instagram.com/reel/ABC",
    });
  });

  it("prefers u over url, and keeps text alongside", () => {
    expect(payloadFromQuery("?u=A&url=B&text=Y")).toEqual({ url: "A", text: "Y" });
  });

  it("falls back to url when u is absent", () => {
    expect(payloadFromQuery("?url=B")).toEqual({ url: "B" });
  });

  it("passes text through untouched (extraction happens downstream)", () => {
    expect(payloadFromQuery("?text=Saw+this+https://www.instagram.com/reel/XYZ")).toEqual({
      text: "Saw this https://www.instagram.com/reel/XYZ",
    });
  });

  it("returns an empty payload when no recognized param is present", () => {
    expect(payloadFromQuery("")).toEqual({});
    expect(payloadFromQuery("?foo=bar")).toEqual({});
  });
});
