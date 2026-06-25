import type { ImportedItem, PendingCapture } from "../types";
import type { ImportedStore } from "./imported-store";
import type { PendingStore } from "../pending-store";
import type { Enricher } from "./enrichment";

export interface PromoteDeps {
  importedStore: ImportedStore;
  pendingStore: PendingStore;
  enricher: Enricher;
  drain: () => void; // fire-and-forget sync trigger
  uuid: () => string;
}

export async function promote(
  item: ImportedItem,
  deps: PromoteDeps,
  collectionId?: string,
): Promise<void> {
  await deps.importedStore.setState(item.id, "promoted");

  const enrichment = await deps.enricher.enrich(item.canonical_url);

  const record: PendingCapture = {
    id: deps.uuid(),
    canonical_url: item.canonical_url,
    raw_payload: item.raw_payload,
    captured_at: item.imported_at,
    source: "import",
    status: "pending",
    parse_ok: item.parse_ok,
    synced: false,
    saved_at: item.saved_at,
    author: item.author,
    media_type: item.media_type,
    ...(enrichment ?? {}),
    ...(item.caption ? { description: item.caption } : {}),
    ...(collectionId ? { collection_id: collectionId } : {}),
  };

  await deps.pendingStore.put(record);
  deps.drain();
}
