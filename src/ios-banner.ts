import { currentPlatform } from "./platform";

// Show the iPhone setup banner only to an iOS user who has not installed the PWA.
const p = currentPlatform();
if (p.ios && !p.standalone) {
  document.getElementById("ios-banner")?.removeAttribute("hidden");
}
