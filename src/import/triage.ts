import type { ImportedItem } from "../types";

export interface AuthorGroup {
  author: string;
  items: ImportedItem[];
}

export function groupAndSort(items: ImportedItem[]): AuthorGroup[] {
  const byAuthor = new Map<string, ImportedItem[]>();
  for (const it of items) {
    const key = it.author || "(unknown)";
    const bucket = byAuthor.get(key);
    if (bucket) bucket.push(it);
    else byAuthor.set(key, [it]);
  }

  const groups: AuthorGroup[] = [];
  for (const [author, groupItems] of byAuthor) {
    groupItems.sort((a, b) => b.saved_at - a.saved_at); // newest first within group
    groups.push({ author, items: groupItems });
  }

  // Most-recent group first (groupItems[0] is the group's newest after the sort above).
  groups.sort((a, b) => b.items[0].saved_at - a.items[0].saved_at);
  return groups;
}
