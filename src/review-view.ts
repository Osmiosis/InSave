import { pullAndReconcile } from "./reminder-pull";
import { createPendingStore } from "./pending-store";
import { getUserId } from "./db";
import type { PendingCapture } from "./types";

const listEl = document.getElementById("list")!;
const emptyEl = document.getElementById("empty")!;

function authorLabel(item: PendingCapture): string {
  if (item.author) return "@" + item.author;
  try {
    return new URL(item.canonical_url).host;
  } catch {
    return "saved reel";
  }
}

async function postAction(userId: string, id: string, action: "done" | "snooze" | "open"): Promise<boolean> {
  try {
    const res = await fetch("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: userId, ids: [id], action }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  await pullAndReconcile();
  const userId = await getUserId();
  const store = await createPendingStore();
  // Reminder items are tagged items carrying server reminder state; show the active pile.
  const items = (await store.listByStatus("tagged"))
    .filter((i) => i.reminder_status === "active")
    .sort((a, b) => {
      const rank = (x: PendingCapture) => (x.importance === "matters" ? 0 : 1);
      return rank(a) - rank(b) || (a.next_due_at ?? 0) - (b.next_due_at ?? 0);
    });

  if (items.length === 0) {
    emptyEl.classList.add("show");
    return;
  }
  for (const item of items) listEl.appendChild(renderCard(item, userId));
}

function renderCard(item: PendingCapture, userId: string): HTMLElement {
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
  if (item.parse_ok) link.addEventListener("click", () => { void postAction(userId, item.id, "open"); });
  card.appendChild(link);

  const controls = document.createElement("div");
  controls.className = "controls";

  const doneBtn = document.createElement("button");
  doneBtn.className = "done";
  doneBtn.textContent = "Done";
  doneBtn.addEventListener("click", async () => {
    doneBtn.disabled = true;
    if (await postAction(userId, item.id, "done")) {
      card.remove();
      if (listEl.children.length === 0) emptyEl.classList.add("show");
    } else {
      doneBtn.disabled = false;
      doneBtn.textContent = "Done (retry)";
    }
  });

  const snoozeBtn = document.createElement("button");
  snoozeBtn.textContent = "Snooze";
  snoozeBtn.addEventListener("click", async () => {
    snoozeBtn.disabled = true;
    if (await postAction(userId, item.id, "snooze")) {
      card.remove();
      if (listEl.children.length === 0) emptyEl.classList.add("show");
    } else {
      snoozeBtn.disabled = false;
      snoozeBtn.textContent = "Snooze (retry)";
    }
  });

  controls.appendChild(doneBtn);
  controls.appendChild(snoozeBtn);
  card.appendChild(controls);
  return card;
}

void main();
