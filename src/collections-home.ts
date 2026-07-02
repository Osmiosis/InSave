import { createCollectionsStore } from "./collections-store";
import { createPendingStore } from "./pending-store";
import { drainAll } from "./drain-all";
import { syncDownIfSignedIn } from "./sync-down";
import { planCollectionDelete, type DeleteChoice } from "./collection-delete";
import type { Collection, PendingCapture } from "./types";

const listEl = document.getElementById("list")!;
const newBtn = document.getElementById("new-collection") as HTMLButtonElement | null;

// Minimal three-way choice modal for a non-empty delete. Resolves the choice.
function chooseDeleteAction(name: string, count: number): Promise<DeleteChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const sheet = document.createElement("div");
    sheet.className = "sheet";
    const p = document.createElement("p");
    p.textContent = `Delete "${name}" (${count} reel${count === 1 ? "" : "s"})?`;
    sheet.appendChild(p);
    const opts: [string, DeleteChoice][] = [
      [`Move ${count} to Saved`, "move"],
      ["Delete the reels too", "dismiss"],
      ["Cancel", "cancel"],
    ];
    for (const [label, choice] of opts) {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", () => { overlay.remove(); resolve(choice); });
      sheet.appendChild(b);
    }
    overlay.addEventListener("click", (e) => { if (e.target === overlay) { overlay.remove(); resolve("cancel"); } });
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
  });
}

async function main(): Promise<void> {
  const collectionsStore = await createCollectionsStore();
  const pendingStore = await createPendingStore();
  const saved = (await collectionsStore.list()).find((c) => c.is_default)!;
  drainAll(pendingStore, collectionsStore).catch(() => {});
  // When signed in, pull the account library so saves from other devices show.
  syncDownIfSignedIn(collectionsStore)
    .then((pulled) => { if (pulled) render(); })
    .catch(() => {});

  const drain = () => { drainAll(pendingStore, collectionsStore).catch(() => {}); };

  async function activeMembers(colId: string): Promise<PendingCapture[]> {
    const all = await pendingStore.listByCollection(colId, saved.id);
    return all.filter((r) => r.status !== "dismissed");
  }

  async function render(): Promise<void> {
    listEl.replaceChildren();
    const collections = await collectionsStore.list();
    for (const c of collections) {
      const count = (await activeMembers(c.id)).length;
      listEl.appendChild(renderCard(c, count));
    }
  }

  function renderCard(c: Collection, count: number): HTMLElement {
    const card = document.createElement("a");
    card.className = "col-card";
    card.href = `/collection.html?id=${encodeURIComponent(c.id)}`;

    const name = document.createElement("span");
    name.className = "col-name";
    name.textContent = c.name;
    card.appendChild(name);

    const meta = document.createElement("span");
    meta.className = "col-count";
    meta.textContent = String(count);
    card.appendChild(meta);

    if (!c.is_default) {
      const rename = document.createElement("button");
      rename.className = "col-rename";
      rename.textContent = "Rename";
      rename.addEventListener("click", async (e) => {
        e.preventDefault();
        const next = prompt("Rename collection", c.name)?.trim();
        if (next) { await collectionsStore.rename(c.id, next); drain(); await render(); }
      });
      card.appendChild(rename);

      const del = document.createElement("button");
      del.className = "col-delete";
      del.textContent = "Delete";
      del.addEventListener("click", async (e) => {
        e.preventDefault();
        await handleDelete(c);
      });
      card.appendChild(del);
    }
    return card;
  }

  async function handleDelete(c: Collection): Promise<void> {
    const members = await activeMembers(c.id);
    const choice: DeleteChoice = members.length === 0 ? "move" : await chooseDeleteAction(c.name, members.length);
    const plan = planCollectionDelete(members, saved.id, choice);
    for (const op of plan.ops) {
      if (op.kind === "move") await pendingStore.move(op.id, op.to!);
      else await pendingStore.dismiss(op.id);
    }
    if (plan.removeCollection) await collectionsStore.remove(c.id);
    drain();
    await render();
  }

  newBtn?.addEventListener("click", async () => {
    const name = prompt("New collection name")?.trim();
    if (!name) return;
    await collectionsStore.create(name);
    drain();
    await render();
  });

  await render();
}

void main();
