import { parse } from "../url-normalize";
import type { ImportedItem, ParsedSavedItem } from "../types";

export interface NormalizeDeps {
  now: () => number;
  uuid: () => string;
}

const defaultDeps: NormalizeDeps = {
  now: () => Date.now(),
  uuid: () => crypto.randomUUID(),
};

export function toImportedItems(
  parsed: ParsedSavedItem[],
  deps: NormalizeDeps = defaultDeps,
): ImportedItem[] {
  const seen = new Set<string>();
  const importedAt = deps.now();
  const out: ImportedItem[] = [];

  for (const p of parsed) {
    const { canonicalUrl, parseOk } = parse({ url: p.url });
    if (parseOk && seen.has(canonicalUrl)) continue; // in-batch dedupe, first wins
    if (parseOk) seen.add(canonicalUrl);

    out.push({
      id: deps.uuid(),
      canonical_url: canonicalUrl,
      author: p.author,
      saved_at: p.savedAt,
      imported_at: importedAt,
      raw_payload: JSON.stringify(p),
      parse_ok: parseOk,
      backlog_state: "dormant",
      caption: p.caption,
      media_type: p.mediaType,
    });
  }

  return out;
}
