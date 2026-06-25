import type { Collection } from "./types";

// Bounded, ordered chip set for the capture surface: existing (non-default)
// collections, newest-created first, capped. "Saved" is excluded — a freshly
// captured reel is already in Saved by default.
export function recentChips(collections: Collection[], cap = 5): Collection[] {
  return collections
    .filter((c) => !c.is_default)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, cap);
}

export interface PickerOptions {
  exclude?: string;
  onPick: (collectionId: string) => void;
}

// Tap-to-pick list of collections for the Move action. Thin DOM; verified via
// manual verification, not unit tests (node test env has no DOM).
export function pickerSheet(collections: Collection[], opts: PickerOptions): HTMLElement {
  const sheet = document.createElement("div");
  sheet.className = "picker-sheet";
  for (const c of collections) {
    if (c.id === opts.exclude) continue;
    const btn = document.createElement("button");
    btn.className = "picker-option";
    btn.textContent = c.name;
    btn.addEventListener("click", () => opts.onPick(c.id));
    sheet.appendChild(btn);
  }
  return sheet;
}
