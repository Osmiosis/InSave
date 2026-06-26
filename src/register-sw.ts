import { createPendingStore } from "./pending-store";
import { drainSync } from "./sync";
import { ensureSubscription } from "./push-subscribe";

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { type: "module" }).catch(() => {});
}

// iOS can silently expire a push subscription; re-mint + re-register on open.
// No-op unless notifications were granted (guarded inside ensureSubscription).
void ensureSubscription().catch(() => {});

// Open the IDB connection once and reuse it across reconnects.
const storePromise = createPendingStore();

// Drain whenever connectivity returns.
window.addEventListener("online", () => {
  storePromise.then((store) => drainSync(store)).catch(() => {});
});
