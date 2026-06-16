import { createPendingStore } from "./pending-store";
import { drainSync } from "./sync";

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { type: "module" }).catch(() => {});
}

// Open the IDB connection once and reuse it across reconnects.
const storePromise = createPendingStore();

// Drain whenever connectivity returns.
window.addEventListener("online", () => {
  storePromise.then((store) => drainSync(store)).catch(() => {});
});
