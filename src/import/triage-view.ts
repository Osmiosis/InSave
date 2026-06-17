import { extractSavedPostsJson } from "./zip";
import { parseSavedPosts } from "./parse-saved-posts";
import { toImportedItems } from "./normalize-import";
import { reconcile } from "./reconcile";
import { groupAndSort, type AuthorGroup } from "./triage";
import { promote as promoteItem } from "./promote";
import { stubEnricher } from "./enrichment";
import { ImportError } from "./errors";
import { createImportedStore } from "./imported-store";
import { createPendingStore } from "../pending-store";
import { drainSync } from "../sync";
import type { ImportedItem } from "../types";

const fileInput = document.getElementById("file") as HTMLInputElement;
const banner = document.getElementById("banner")!;
const summary = document.getElementById("summary")!;
const list = document.getElementById("list")!;

function showError(message: string): void {
  banner.textContent = message;
  banner.classList.add("show");
}

function clearError(): void {
  banner.textContent = "";
  banner.classList.remove("show");
}

fileInput.addEventListener("change", async () => {
  clearError();
  const file = fileInput.files?.[0];
  if (!file) return;

  try {
    const jsonText = await extractSavedPostsJson(file);
    const parsed = parseSavedPosts(jsonText);
    const items = toImportedItems(parsed);

    const importedStore = await createImportedStore();
    const pendingStore = await createPendingStore();
    const { toInsert, skippedExisting } = await reconcile(items, {
      async existingImported(u) { return Boolean(await importedStore.getByCanonicalUrl(u)); },
      async existingCapture(u) { return Boolean(await pendingStore.getByCanonicalUrl(u)); },
    });
    await importedStore.bulkPut(toInsert);

    const dormant = await importedStore.listByState("dormant");
    summary.textContent =
      `${dormant.length} in your backlog` +
      (skippedExisting ? ` · ${skippedExisting} already saved` : "");
    render(groupAndSort(dormant));
  } catch (err) {
    if (err instanceof ImportError) showError(err.message);
    else showError("Something went wrong reading that file.");
  }
});

function render(groups: AuthorGroup[]): void {
  list.textContent = "";
  for (const group of groups) {
    list.appendChild(renderGroup(group));
  }
}

function renderGroup(group: AuthorGroup): HTMLElement {
  const section = document.createElement("section");
  section.className = "group";

  const h2 = document.createElement("h2");
  h2.textContent = `@${group.author} — ${group.items.length} saved`;
  section.appendChild(h2);

  const bulk = document.createElement("div");
  bulk.className = "bulk";
  const keepAll = document.createElement("button");
  keepAll.textContent = "Keep all";
  const dismissAll = document.createElement("button");
  dismissAll.textContent = "Dismiss all";
  bulk.appendChild(keepAll);
  bulk.appendChild(dismissAll);
  section.appendChild(bulk);

  const ul = document.createElement("ul");
  for (const item of group.items) {
    ul.appendChild(renderItem(item));
  }
  section.appendChild(ul);

  keepAll.addEventListener("click", async () => {
    for (const item of group.items) await keep(item);
    section.remove();
  });
  dismissAll.addEventListener("click", () => {
    section.remove(); // dismissed items stay dormant in the store, just hidden
  });

  return section;
}

function renderItem(item: ImportedItem): HTMLElement {
  const li = document.createElement("li");

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = item.media_type;

  const link = document.createElement("a");
  link.href = item.canonical_url || "#";
  link.textContent = item.parse_ok ? item.canonical_url : "(unreadable link — needs review)";
  link.target = "_blank";
  link.rel = "noopener";

  const keepBtn = document.createElement("button");
  keepBtn.textContent = "Keep";
  keepBtn.addEventListener("click", async () => {
    await keep(item);
    li.classList.add("kept");
    keepBtn.disabled = true;
  });

  const skipBtn = document.createElement("button");
  skipBtn.textContent = "Skip";
  skipBtn.addEventListener("click", () => li.remove());

  li.appendChild(keepBtn);
  li.appendChild(skipBtn);
  li.appendChild(badge);
  li.appendChild(link);

  if (item.caption) {
    const caption = document.createElement("p");
    caption.className = "caption";
    caption.textContent = item.caption;
    li.appendChild(caption);
  }

  return li;
}

async function keep(item: ImportedItem): Promise<void> {
  const importedStore = await createImportedStore();
  // Idempotent: skip if already promoted (e.g. "Keep all" over an item the user
  // already kept individually) so we don't write duplicate pending_capture rows.
  if (item.canonical_url) {
    const stored = await importedStore.getByCanonicalUrl(item.canonical_url);
    if (stored?.backlog_state === "promoted") return;
  }
  const pendingStore = await createPendingStore();
  await promoteItem(item, {
    importedStore,
    pendingStore,
    enricher: stubEnricher,
    drain: () => { drainSync(pendingStore).catch(() => {}); },
    uuid: () => crypto.randomUUID(),
  });
}
