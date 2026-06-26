import { createPendingStore } from "./pending-store";
import { createCollectionsStore } from "./collections-store";
import { handleCapture } from "./capture";
import { drainAll } from "./drain-all";
import { capturedRedirectUrl } from "./captured-url";
import { parse } from "./url-normalize";
import type { SharePayload } from "./types";

const btn = document.getElementById("paste-link") as HTMLButtonElement | null;
const toast = document.getElementById("toast");

function showToast(msg: string): void {
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 2500);
}

async function pasteCapture(): Promise<void> {
  let text = "";
  try {
    text = await navigator.clipboard.readText(); // iOS: must run inside the click gesture
  } catch {
    showToast("Couldn't read clipboard");
    return;
  }

  const payload: SharePayload = { text };
  if (!parse(payload).parseOk) {
    showToast("No Instagram link found on your clipboard");
    return;
  }

  const store = await createPendingStore();
  try {
    const result = await handleCapture(payload, store);
    const collections = await createCollectionsStore();
    drainAll(store, collections).catch(() => {}); // fire-and-forget
    location.assign(capturedRedirectUrl(result.status, result.record?.id));
  } catch {
    showToast("Couldn't save — try again");
  }
}

btn?.addEventListener("click", () => {
  void pasteCapture();
});
