import { createCollectionsStore } from "./collections-store";
import { createPendingStore } from "./pending-store";
import { drainAll } from "./drain-all";
import { renderReelCard } from "./reel-card";
import { pickerSheet } from "./collection-picker";
import type { Collection, PendingCapture } from "./types";

const titleEl = document.getElementById("title")!;
const listEl = document.getElementById("list")!;
const emptyEl = document.getElementById("empty")!;

async function main(): Promise<void> {
  const collectionsStore = await createCollectionsStore();
  const pendingStore = await createPendingStore();
  const collections = await collectionsStore.list();
  const saved = collections.find((c) => c.is_default)!;
  const id = new URLSearchParams(location.search).get("id") ?? saved.id;
  const current: Collection = collections.find((c) => c.id === id) ?? saved;
  titleEl.textContent = current.name;
  drainAll(pendingStore, collectionsStore).catch(() => {});

  const members = (await pendingStore.listByCollection(current.id, saved.id))
    .filter((r) => r.status !== "dismissed");
  if (members.length === 0) {
    emptyEl.classList.add("show");
    return;
  }
  for (const item of members) listEl.appendChild(card(item));

  function card(item: PendingCapture): HTMLElement {
    const el = renderReelCard(item);
    const move = document.createElement("button");
    move.textContent = "Move";
    move.addEventListener("click", () => openPicker(item, el));
    el.appendChild(move);
    return el;
  }

  function openPicker(item: PendingCapture, el: HTMLElement): void {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const sheet = pickerSheet(collections, {
      exclude: current.id,
      onPick: async (target) => {
        overlay.remove();
        await pendingStore.move(item.id, target);
        drainAll(pendingStore, collectionsStore).catch(() => {});
        el.remove();
        if (listEl.children.length === 0) emptyEl.classList.add("show");
      },
    });
    overlay.appendChild(sheet);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }
}

void main();
