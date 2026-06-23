import { createPendingStore } from "./pending-store";
import { drainSync } from "./sync";
import type { PendingCapture } from "./types";

const listEl = document.getElementById("list")!;
const emptyEl = document.getElementById("empty")!;
const toastEl = document.getElementById("toast")!;

// Non-binding first-run examples: shown only when the user has no tags yet.
const EXAMPLE_TAGS = ["skincare", "robotics", "claude tricks"];

let toastTimer: ReturnType<typeof setTimeout> | undefined;

function showUndoToast(message: string, onUndo: () => void): void {
  toastEl.textContent = message + " ";
  const btn = document.createElement("button");
  btn.textContent = "Undo";
  btn.addEventListener("click", () => {
    onUndo();
    hideToast();
  });
  toastEl.appendChild(btn);
  toastEl.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}

function hideToast(): void {
  toastEl.classList.remove("show");
  toastEl.textContent = "";
}

function authorLabel(item: PendingCapture): string {
  if (item.author) return "@" + item.author;
  try {
    return new URL(item.canonical_url).host;
  } catch {
    return "saved reel";
  }
}

async function main(): Promise<void> {
  const store = await createPendingStore();
  const drain = () => { drainSync(store).catch(() => {}); };

  const items = await store.listByStatus("pending");
  const chips = await store.listDistinctTags();

  if (items.length === 0) {
    emptyEl.classList.add("show");
    return;
  }

  for (const item of items) {
    listEl.appendChild(renderCard(item, chips, store, drain));
  }
}

function renderCard(
  item: PendingCapture,
  chips: string[],
  store: Awaited<ReturnType<typeof createPendingStore>>,
  drain: () => void,
): HTMLElement {
  const card = document.createElement("section");
  card.className = "card";

  const meta = document.createElement("div");
  meta.className = "meta";
  const author = document.createElement("span");
  author.className = "author";
  author.textContent = authorLabel(item);
  meta.appendChild(author);
  if (item.media_type) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = item.media_type;
    meta.appendChild(badge);
  }
  card.appendChild(meta);

  if (item.description) {
    const cap = document.createElement("p");
    cap.className = "caption";
    cap.textContent = item.description;
    card.appendChild(cap);
  }

  const link = document.createElement("a");
  link.className = "link";
  link.href = item.canonical_url || "#";
  link.textContent = item.parse_ok ? "Open in Instagram ↗" : "(unreadable link — needs review)";
  link.target = "_blank";
  link.rel = "noopener";
  card.appendChild(link);

  // Importance toggle (default normal; one tap to elevate).
  let importance: "normal" | "matters" = "normal";
  const importanceBtn = document.createElement("button");
  importanceBtn.textContent = "☆ Matters";
  importanceBtn.addEventListener("click", () => {
    importance = importance === "normal" ? "matters" : "normal";
    importanceBtn.classList.toggle("matters", importance === "matters");
    importanceBtn.textContent = importance === "matters" ? "★ Matters" : "☆ Matters";
  });

  async function applyTag(topic: string): Promise<void> {
    await store.tag(item.id, { topic_tags: [topic], importance });
    drain();
    card.remove();
    if (listEl.children.length === 0) emptyEl.classList.add("show");
  }

  // Reusable chips (or non-binding examples on first run).
  const chipsRow = document.createElement("div");
  chipsRow.className = "chips";
  if (chips.length > 0) {
    for (const tag of chips) {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.textContent = tag;
      chip.addEventListener("click", () => { void applyTag(tag); });
      chipsRow.appendChild(chip);
    }
  } else {
    for (const tag of EXAMPLE_TAGS) {
      const chip = document.createElement("button");
      chip.className = "chip example";
      chip.textContent = tag;
      chip.disabled = true; // examples demonstrate the gesture; they are not real tags
      chipsRow.appendChild(chip);
    }
  }
  card.appendChild(chipsRow);

  // New-tag input + dismiss.
  const controls = document.createElement("div");
  controls.className = "controls";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "New tag…";
  const addBtn = document.createElement("button");
  addBtn.textContent = "Tag";
  const commit = () => {
    const v = input.value.trim();
    if (v) void applyTag(v);
  };
  addBtn.addEventListener("click", commit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); });

  const dismissBtn = document.createElement("button");
  dismissBtn.textContent = "Dismiss";
  dismissBtn.addEventListener("click", async () => {
    await store.dismiss(item.id);
    drain();
    card.remove();
    if (listEl.children.length === 0) emptyEl.classList.add("show");
    showUndoToast("Dismissed.", () => {
      void store.restore(item.id).then(() => {
        drain();
        emptyEl.classList.remove("show");
        listEl.appendChild(renderCard(item, chips, store, drain));
      });
    });
  });

  controls.appendChild(importanceBtn);
  controls.appendChild(input);
  controls.appendChild(addBtn);
  controls.appendChild(dismissBtn);
  card.appendChild(controls);

  return card;
}

void main();
