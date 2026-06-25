import type { PendingCapture } from "./types";

export type DeleteChoice = "move" | "dismiss" | "cancel";

export interface DeleteOp {
  kind: "move" | "dismiss";
  id: string;
  to?: string; // present only for kind === "move"
}

export interface DeletePlan {
  ops: DeleteOp[];
  removeCollection: boolean;
}

// Pure planner for deleting a collection. `members` are the collection's
// non-dismissed reels. "move" re-homes them to Saved; "dismiss" removes them
// too (recoverable); "cancel" is a no-op. Empty collections still remove.
export function planCollectionDelete(
  members: PendingCapture[],
  savedId: string,
  choice: DeleteChoice,
): DeletePlan {
  if (choice === "cancel") return { ops: [], removeCollection: false };
  const ops: DeleteOp[] =
    choice === "move"
      ? members.map((m) => ({ kind: "move", id: m.id, to: savedId }))
      : members.map((m) => ({ kind: "dismiss", id: m.id }));
  return { ops, removeCollection: true };
}
