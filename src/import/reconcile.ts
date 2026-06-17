import type { ImportedItem } from "../types";

export interface ReconcileLookup {
  existingImported(canonicalUrl: string): Promise<boolean>;
  existingCapture(canonicalUrl: string): Promise<boolean>;
}

export interface ReconcileResult {
  toInsert: ImportedItem[];
  skippedExisting: number;
}

export async function reconcile(
  incoming: ImportedItem[],
  lookup: ReconcileLookup,
): Promise<ReconcileResult> {
  const toInsert: ImportedItem[] = [];
  let skippedExisting = 0;

  for (const item of incoming) {
    // Unparsed items have no usable dedupe key — keep them (flagged for review).
    if (!item.parse_ok || !item.canonical_url) {
      toInsert.push(item);
      continue;
    }
    const known =
      (await lookup.existingImported(item.canonical_url)) ||
      (await lookup.existingCapture(item.canonical_url));
    if (known) {
      skippedExisting++;
      continue;
    }
    toInsert.push(item);
  }

  return { toInsert, skippedExisting };
}
