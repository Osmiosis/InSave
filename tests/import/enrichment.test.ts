import { describe, it, expect } from "vitest";
import { stubEnricher } from "../../src/import/enrichment";

describe("stubEnricher", () => {
  it("returns null (no enrichment available)", async () => {
    expect(await stubEnricher.enrich("https://www.instagram.com/reel/A")).toBeNull();
  });
});
