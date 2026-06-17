import type { ParsedSavedItem } from "../types";
import { ImportError } from "./errors";

interface LabelValue {
  label?: unknown;
  value?: unknown;
  href?: unknown;
  title?: unknown;
  dict?: unknown;
}

function labelValues(entry: unknown): LabelValue[] {
  if (!entry || typeof entry !== "object") return [];
  const lv = (entry as { label_values?: unknown }).label_values;
  return Array.isArray(lv) ? (lv as LabelValue[]) : [];
}

function byLabel(items: LabelValue[], label: string): LabelValue | undefined {
  return items.find((i) => i && typeof i === "object" && i.label === label);
}

function byTitle(items: LabelValue[], title: string): LabelValue | undefined {
  return items.find((i) => i && typeof i === "object" && i.title === title);
}

function ownerUsername(items: LabelValue[]): string {
  const owner = byTitle(items, "Owner");
  const outer = owner && Array.isArray(owner.dict) ? (owner.dict as unknown[]) : [];
  const first = outer[0];
  const inner =
    first && typeof first === "object" && Array.isArray((first as { dict?: unknown }).dict)
      ? ((first as { dict: unknown[] }).dict as LabelValue[])
      : [];
  const username = byLabel(inner, "Username");
  return typeof username?.value === "string" ? username.value : "";
}

function mediaTypeFromUrl(url: string): "reel" | "post" {
  return url.includes("/reel/") ? "reel" : "post";
}

function resolveEntryList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const wrapped = (data as { saved_saved_media?: unknown })?.saved_saved_media;
  if (Array.isArray(wrapped)) return wrapped;
  throw new ImportError();
}

export function parseSavedPosts(jsonText: string): ParsedSavedItem[] {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new ImportError();
  }

  const list = resolveEntryList(data);

  const items: ParsedSavedItem[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const lv = labelValues(entry);

    const urlItem = byLabel(lv, "URL");
    const url =
      typeof urlItem?.value === "string"
        ? urlItem.value
        : typeof urlItem?.href === "string"
          ? urlItem.href
          : "";

    const captionItem = byLabel(lv, "Caption");
    const caption =
      typeof captionItem?.value === "string" && captionItem.value
        ? captionItem.value
        : undefined;

    const tsRaw = (entry as { timestamp?: unknown }).timestamp;
    const tsSeconds = typeof tsRaw === "number" ? tsRaw : 0;

    items.push({
      url,
      author: ownerUsername(lv),
      savedAt: tsSeconds > 0 ? tsSeconds * 1000 : 0,
      caption,
      mediaType: mediaTypeFromUrl(url),
    });
  }

  if (items.length === 0) throw new ImportError();
  return items;
}
