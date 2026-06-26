import { currentPlatform } from "./platform";
import { SHORTCUT_URL } from "./ios-config";

const p = currentPlatform();

if (p.standalone) {
  // Already installed — show the confirmation, hide the steps.
  document.getElementById("confirm")?.classList.add("show");
  document.getElementById("steps")?.classList.add("hidden");
} else if (p.inAppBrowser) {
  // In-app browser — Add-to-Home-Screen is unavailable; route to Safari.
  document.getElementById("inapp-notice")?.classList.add("show");
  document.getElementById("install-steps")?.classList.add("hidden");
}

if (SHORTCUT_URL) {
  const slot = document.getElementById("shortcut-slot");
  if (slot) {
    const a = document.createElement("a");
    a.href = SHORTCUT_URL;
    a.className = "shortcut-btn";
    a.textContent = "Add the InSave shortcut";
    slot.appendChild(a);
  }
}
