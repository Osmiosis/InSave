import { payloadFromQuery } from "./share-query";
import { createPendingStore } from "./pending-store";
import { createCollectionsStore } from "./collections-store";
import { handleCapture } from "./capture";
import { drainAll } from "./drain-all";
import { capturedRedirectUrl } from "./captured-url";

async function main(): Promise<void> {
  const payload = payloadFromQuery(location.search);
  // Nothing to capture (Shortcut misfire / hand-typed link) — degrade to home,
  // never silently drop.
  if (!payload.url && !payload.text) {
    location.replace("/");
    return;
  }

  const store = await createPendingStore();
  let status = "error";
  let id: string | undefined;
  try {
    const result = await handleCapture(payload, store);
    status = result.status;
    id = result.record?.id;
    const collections = await createCollectionsStore();
    drainAll(store, collections).catch(() => {}); // fire-and-forget; retries later
  } catch {
    status = "error";
  }
  location.replace(capturedRedirectUrl(status, id));
}

void main();
