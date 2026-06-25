import { createPendingStore } from "./pending-store";
import { createCollectionsStore } from "./collections-store";
import { drainAll } from "./drain-all";
import { renderReelCard } from "./reel-card";
import { recentChips, pickerSheet } from "./collection-picker";
import type { PendingCapture } from "./types";

const listEl = document.getElementById("list")!;
const emptyEl = document.getElementById("empty")!;
const toastEl = document.getElementById("toast")!;

let toastTimer: ReturnType<typeof setTimeout> | undefined;

function showUndoToast(message: string, onUndo: () => void): void {
  toastEl.textContent = message + " ";
  const btn = document.createElement("button");
  btn.textContent = "Undo";
  btn.addEventListener("click", () => { onUndo(); hideToast(); });
  toastEl.appendChild(btn);
  toastEl.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}

function hideToast(): void {
  toastEl.classList.remove("show");
  toastEl.textContent = "";
}

async function main(): Promise<void> {
  const collectionsStore = await createCollectionsStore();
  const pendingStore = await createPendingStore();
  const collections = await collectionsStore.list();
  const saved = collections.find((c) => c.is_default)!;
  const drain = () => { drainAll(pendingStore, collectionsStore).catch(() => {}); };
  drain();

  const items = (await pendingStore.listByCollection(saved.id, saved.id))
    .filter((r) => r.status !== "dismissed");

  if (items.length === 0) {
    emptyEl.classList.add("show");
    return;
  }
  for (const item of items) listEl.appendChild(renderCard(item));

  function renderCard(item: PendingCapture): HTMLElement {
    const card = renderReelCard(item);

    const chipsRow = document.createElement("div");
    chipsRow.className = "chips";
    for (const c of recentChips(collections)) {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.textContent = c.name;
      chip.addEventListener("click", () => { void moveTo(item, c.id, card); });
      chipsRow.appendChild(chip);
    }
    // "More…": full picker for collections beyond the chip cap (Saved excluded —
    // the item is already in Saved).
    const moreBtn = document.createElement("button");
    moreBtn.textContent = "More…";
    moreBtn.addEventListener("click", () => openPicker(item, card));
    chipsRow.appendChild(moreBtn);
    card.appendChild(chipsRow);

    const controls = document.createElement("div");
    controls.className = "controls";
    const dismissBtn = document.createElement("button");
    dismissBtn.textContent = "Dismiss";
    dismissBtn.addEventListener("click", async () => {
      await pendingStore.dismiss(item.id);
      drain();
      card.remove();
      if (listEl.children.length === 0) emptyEl.classList.add("show");
      showUndoToast("Dismissed.", () => {
        void pendingStore.restore(item.id).then(() => {
          drain();
          emptyEl.classList.remove("show");
          listEl.appendChild(renderCard(item));
        });
      });
    });
    controls.appendChild(dismissBtn);
    card.appendChild(controls);

    return card;
  }

  async function moveTo(item: PendingCapture, collectionId: string, card: HTMLElement): Promise<void> {
    await pendingStore.move(item.id, collectionId);
    drain();
    card.remove();
    if (listEl.children.length === 0) emptyEl.classList.add("show");
    const name = collections.find((c) => c.id === collectionId)?.name ?? "collection";
    showUndoToast(`Moved to ${name}.`, () => {
      // Re-home to Saved (null-is-Saved makes the explicit Saved id equivalent).
      void pendingStore.move(item.id, saved.id).then(() => {
        drain();
        emptyEl.classList.remove("show");
        listEl.appendChild(renderCard(item));
      });
    });
  }

  function openPicker(item: PendingCapture, card: HTMLElement): void {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const sheet = pickerSheet(collections, {
      exclude: saved.id,
      onPick: (target) => { overlay.remove(); void moveTo(item, target, card); },
    });
    overlay.appendChild(sheet);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }
}

void main();
