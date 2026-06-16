import type { SharePayload } from "./types";

const TRACKING_PARAMS = [/^igsh$/i, /^igshid$/i, /^utm_/i, /^fbclid$/i, /^__/];
const INSTAGRAM_HOST = /(^|\.)instagram\.com$/i;
// matches /reel/, /reels/, /p/ shortcodes
const REEL_URL_RE = /https?:\/\/(?:www\.)?instagram\.com\/(?:reels?|p)\/[A-Za-z0-9_-]+\/?(?:\?[^\s]*)?/i;

export function extractReelUrl(payload: SharePayload): string | null {
  for (const field of [payload.url, payload.text, payload.title]) {
    if (!field) continue;
    const trimmed = field.trim();
    // whole-field url
    try {
      const u = new URL(trimmed);
      if (INSTAGRAM_HOST.test(u.hostname) && /\/(reels?|p)\//i.test(u.pathname)) {
        return trimmed;
      }
    } catch { /* not a bare url, fall through to regex */ }
    // embedded url
    const m = trimmed.match(REEL_URL_RE);
    if (m) return m[0];
  }
  return null;
}

export function canonicalize(rawUrl: string): string {
  const u = new URL(rawUrl);
  u.hostname = "www.instagram.com";
  u.protocol = "https:";
  u.hash = "";
  // strip tracking params
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) u.searchParams.delete(key);
  }
  // normalize /reels/ -> /reel/
  u.pathname = u.pathname.replace(/\/reels\//i, "/reel/");
  // drop trailing slash
  u.pathname = u.pathname.replace(/\/+$/, "");
  const qs = u.searchParams.toString();
  return `${u.protocol}//${u.hostname}${u.pathname}${qs ? `?${qs}` : ""}`;
}

export function parse(payload: SharePayload): { canonicalUrl: string; parseOk: boolean } {
  const raw = extractReelUrl(payload);
  if (!raw) return { canonicalUrl: "", parseOk: false };
  try {
    return { canonicalUrl: canonicalize(raw), parseOk: true };
  } catch {
    return { canonicalUrl: "", parseOk: false };
  }
}
