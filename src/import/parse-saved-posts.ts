import type { ParsedSavedItem } from "../types";
import { ImportError } from "./errors";

interface MapSlot {
  href?: unknown;
  timestamp?: unknown;
}

export function parseSavedPosts(jsonText: string): ParsedSavedItem[] {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new ImportError();
  }

  const list = (data as { saved_saved_media?: unknown })?.saved_saved_media;
  if (!Array.isArray(list)) throw new ImportError();

  const items: ParsedSavedItem[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { title?: unknown; string_map_data?: unknown };
    const author = typeof e.title === "string" ? e.title : "";

    let href = "";
    let tsSeconds = 0;
    const map = e.string_map_data;
    if (map && typeof map === "object") {
      const slots = map as Record<string, MapSlot>;
      const slot = slots["Saved on"] ?? Object.values(slots)[0];
      if (slot && typeof slot === "object") {
        if (typeof slot.href === "string") href = slot.href;
        if (typeof slot.timestamp === "number") tsSeconds = slot.timestamp;
      }
    }

    items.push({ url: href, author, savedAt: tsSeconds > 0 ? tsSeconds * 1000 : 0, mediaType: "reel" });
  }

  if (items.length === 0) throw new ImportError();
  return items;
}
