import type { EnrichmentResult } from "../types";

// The swappable enrichment seam. A real implementation (oEmbed/scrape) can replace
// the stub without touching the import or tag-queue flow. Only ever called on
// promoted items.
export interface Enricher {
  enrich(canonicalUrl: string): Promise<EnrichmentResult | null>;
}

export const stubEnricher: Enricher = {
  async enrich() {
    return null;
  },
};
