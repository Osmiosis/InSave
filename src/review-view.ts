import { pullAndReconcile } from "./reminder-pull";
import { createPendingStore } from "./pending-store";
import type { PendingStore } from "./pending-store";
import { drainSync } from "./sync";
import { getUserId } from "./db";
import type { PendingCapture, Importance } from "./types";
import { normalizeImportance } from "./reminder/spacing";
import { dateInputToEpoch } from "./deadline-input";

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
      const order: Record<string, number> = { high: 0, normal: 1, low: 2 };
      const rank = (x: PendingCapture) => order[normalizeImportance(x.importance)];
      return rank(a) - rank(b) || (a.next_due_at ?? 0) - (b.next_due_at ?? 0);
    });

  if (items.length === 0) {
    emptyEl.classList.add("show");
    return;
  }
  for (const item of items) listEl.appendChild(renderCard(item, userId, store));
}

const TIERS: Importance[] = ["low", "normal", "high"];

function importanceRow(item: PendingCapture, store: PendingStore): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "importance";

  const label = document.createElement("span");
  label.className = "ctl-label";
  label.textContent = "importance";
  wrap.appendChild(label);

  let current = normalizeImportance(item.importance);
  const btns = new Map<Importance, HTMLButtonElement>();

  for (const tier of TIERS) {
    const b = document.createElement("button");
    b.className = "tier" + (tier === current ? " active" : "");
    b.textContent = tier;
    b.addEventListener("click", async () => {
      if (tier === current) return;
      try {
        await store.setImportance(item.id, tier);
        current = tier;
        for (const [t, el] of btns) el.classList.toggle("active", t === tier);
        void drainSync(store).catch(() => {});
      } catch {
        /* leave UI as-is; user can retry */
      }
    });
    btns.set(tier, b);
    wrap.appendChild(b);
  }

  return wrap;
}

function deadlineControl(item: PendingCapture, store: PendingStore): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "deadline";

  const render = (deadline: number | null): void => {
    wrap.replaceChildren();

    if (deadline == null) {
      const add = document.createElement("button");
      add.className = "deadline-add";
      add.textContent = "+ Set deadline";
      add.addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "date";
        input.className = "deadline-input";
        input.addEventListener("change", async () => {
          const epoch = dateInputToEpoch(input.value);
          if (epoch == null) return; // empty / invalid → no-op
          try {
            await store.setDeadline(item.id, epoch);
            void drainSync(store).catch(() => {});
            render(epoch);
          } catch {
            /* keep the input open; user can retry */
          }
        });
        wrap.replaceChildren(input);
        input.focus();
      });
      wrap.appendChild(add);
    } else {
      const badge = document.createElement("span");
      badge.className = "deadline-set";
      badge.textContent = new Date(deadline).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });

      const clear = document.createElement("button");
      clear.className = "deadline-clear";
      clear.textContent = "×";
      clear.setAttribute("aria-label", "Clear deadline");
      clear.addEventListener("click", async () => {
        try {
          await store.setDeadline(item.id, null);
          void drainSync(store).catch(() => {});
          render(null);
        } catch {
          /* keep the badge; user can retry */
        }
      });

      wrap.appendChild(badge);
      wrap.appendChild(clear);
    }
  };

  render(item.deadline_at ?? null);
  return wrap;
}

function renderCard(item: PendingCapture, userId: string, store: PendingStore): HTMLElement {
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

  card.appendChild(importanceRow(item, store));
  card.appendChild(deadlineControl(item, store));

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
