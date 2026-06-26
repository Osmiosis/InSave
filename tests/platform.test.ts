import { describe, it, expect } from "vitest";
import { detectPlatform } from "../src/platform";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IG_INAPP = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 302.0.0.0";
const FB_INAPP = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS;FBAV/420.0.0]";
const ANDROID = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

describe("detectPlatform", () => {
  it("flags iPhone Safari as iOS, not in-app", () => {
    expect(detectPlatform(IPHONE, false)).toEqual({ ios: true, inAppBrowser: false, standalone: false });
  });
  it("flags iPad as iOS", () => {
    expect(detectPlatform(IPAD, false).ios).toBe(true);
  });
  it("flags an Instagram in-app browser on iPhone", () => {
    const p = detectPlatform(IG_INAPP, false);
    expect(p.ios).toBe(true);
    expect(p.inAppBrowser).toBe(true);
  });
  it("flags a Facebook in-app browser (FBAN/FBAV)", () => {
    expect(detectPlatform(FB_INAPP, false).inAppBrowser).toBe(true);
  });
  it("does not flag Android Chrome as iOS or in-app", () => {
    expect(detectPlatform(ANDROID, false)).toEqual({ ios: false, inAppBrowser: false, standalone: false });
  });
  it("does not flag desktop as iOS", () => {
    expect(detectPlatform(DESKTOP, false).ios).toBe(false);
  });
  it("passes the standalone flag through", () => {
    expect(detectPlatform(IPHONE, true).standalone).toBe(true);
  });
});
