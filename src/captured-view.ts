import { createCollectionsStore } from "./collections-store";
import { createPendingStore } from "./pending-store";
import { drainAll } from "./drain-all";
import { recentChips } from "./collection-picker";

declare global {
  interface Window { __insaveCancelReturn?: () => void }
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const id = params.get("id");
  const status = params.get("status") ?? "saved";
  // Nothing to enhance: no saved record (e.g. error) or an old SW that didn't pass an id.
  if (!id || status === "error") return;

  const chipsEl = document.getElementById("chips");
  const toastEl = document.getElementById("toast");
  if (!chipsEl) return;

  const collectionsStore = await createCollectionsStore();
  const pendingStore = await createPendingStore();
  const chips = recentChips(await collectionsStore.list());

  for (const c of chips) {
    const btn = document.createElement("button");
    btn.className = "chip";
    btn.textContent = c.name;
    btn.addEventListener("click", async () => {
      window.__insaveCancelReturn?.();           // we control the return now
      try {
        await pendingStore.move(id, c.id);        // re-target the already-saved reel
        if (toastEl) toastEl.textContent = `Moved to ${c.name} ✓`;
        drainAll(pendingStore, collectionsStore).catch(() => {});
      } catch {
        if (toastEl) toastEl.textContent = `Couldn't move — still in Saved.`;
      }
      window.setTimeout(() => { if (history.length > 1) history.back(); }, 800);
    });
    chipsEl.appendChild(btn);
  }

  // Create-in-app path (no inline create on the hot path; PRD §12 lean).
  const newLink = document.createElement("a");
  newLink.className = "new-in-app";
  newLink.href = "/index.html";
  newLink.textContent = "+ New in app";
  chipsEl.appendChild(newLink);
}

void main();
