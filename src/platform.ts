export interface Platform {
  ios: boolean;
  inAppBrowser: boolean;
  standalone: boolean;
}

// Pure: classify a user-agent. `isStandalone` is supplied by the caller (it
// comes from platform APIs, not the UA string).
export function detectPlatform(ua: string, isStandalone: boolean): Platform {
  const ios = /iphone|ipad|ipod/i.test(ua);
  const inAppBrowser = /FBAN|FBAV|Instagram|Line\/|Twitter|Snapchat|Pinterest|TikTok/i.test(ua);
  return { ios, inAppBrowser, standalone: isStandalone };
}

// DOM glue (untested): reads the live navigator/window. Used by the onboarding
// page and the home banner.
export function currentPlatform(): Platform {
  const standalone =
    (navigator as unknown as { standalone?: boolean }).standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
  return detectPlatform(navigator.userAgent, standalone);
}
