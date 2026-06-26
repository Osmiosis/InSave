import type { SharePayload } from "./types";

// Maps a deep-link query string to a SharePayload for the existing capture
// pipeline. `u` is the canonical param the iOS Shortcut sends; `url`/`text`
// are accepted aliases. extractReelUrl (url-normalize) does the actual URL
// extraction downstream, so this only routes raw values into the payload.
export function payloadFromQuery(search: string): SharePayload {
  const p = new URLSearchParams(search);
  const u = p.get("u") ?? p.get("url") ?? undefined;
  const text = p.get("text") ?? undefined;
  return { ...(u ? { url: u } : {}), ...(text ? { text } : {}) };
}
