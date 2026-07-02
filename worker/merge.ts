// The merge engine core (PRD 08 §7). Pure planning + field precedence for
// reconciling an anonymous device's pending_capture rows into an account.
// The D1 executor (worker/index.ts) reads rows, calls these, and batches the
// resulting statements atomically. Server-owned reminder-state columns are
// deliberately absent here, so a merge can never touch them.

export interface MergeRow {
  id: string;
  canonical_url: string;
  // Device-owned content fields (the only columns a merge may write).
  status: string | null;
  saved_at: number | null;
  description: string | null;
  topic_tags: string | null;
  importance: string | null;
  tagged_at: number | null;
  author: string | null;
  media_type: string | null;
  collection_id: string | null;
  deadline_at: number | null;
}

// Device-owned columns, in a fixed order for statement building.
export const MERGE_FIELDS = [
  "status",
  "saved_at",
  "description",
  "topic_tags",
  "importance",
  "tagged_at",
  "author",
  "media_type",
  "collection_id",
  "deadline_at",
] as const;

export type MergedFields = Pick<MergeRow, (typeof MERGE_FIELDS)[number]>;

// Merge device-owned content from a colliding anon row into the account row.
// Additive: any field present on only one side is kept. On a genuine conflict
// the more-recently-tagged row wins per field (tagged_at is the one content
// mutation timestamp we have). Never returns server-owned reminder state.
export function mergeContent(account: MergeRow, anon: MergeRow): MergedFields {
  const anonNewer = (anon.tagged_at ?? 0) > (account.tagged_at ?? 0);
  const winner = anonNewer ? anon : account;
  const loser = anonNewer ? account : anon;
  const out = {} as Record<string, unknown>;
  for (const f of MERGE_FIELDS) {
    out[f] = winner[f] ?? loser[f];
  }
  return out as MergedFields;
}

export type MergeOp =
  | { kind: "repoint"; id: string }
  | { kind: "coalesce"; keepId: string; deleteId: string; fields: MergedFields };

// Decide, per anon row, whether to re-point it to the account (no collision)
// or coalesce it into the account's existing row for the same canonical_url.
// Rows with an empty canonical_url are never deduped — always re-pointed.
export function planPendingMerge(
  anonRows: MergeRow[],
  accountByUrl: Map<string, MergeRow>,
): MergeOp[] {
  const ops: MergeOp[] = [];
  for (const anon of anonRows) {
    const collision = anon.canonical_url ? accountByUrl.get(anon.canonical_url) : undefined;
    if (collision) {
      ops.push({
        kind: "coalesce",
        keepId: collision.id,
        deleteId: anon.id,
        fields: mergeContent(collision, anon),
      });
    } else {
      ops.push({ kind: "repoint", id: anon.id });
    }
  }
  return ops;
}

export interface Stmt {
  sql: string;
  params: unknown[];
}

// Collections follow their owner on merge. Non-default same-name collections
// are left as separate rows (cosmetic dup, per spec). But the single default
// "Saved" must stay unique: when both sides have one, fold the anon default's
// reels into the account default and drop the anon default.
// `reelRemap` MUST run before reels are re-pointed to the account (it matches on
// the still-anonymous user_id).
export function buildCollectionMerge(
  accountId: string,
  anonId: string,
  accountDefaultId: string | null,
  anonDefaultId: string | null,
): { reelRemap: Stmt[]; collectionOps: Stmt[] } {
  const collapse = accountDefaultId && anonDefaultId && accountDefaultId !== anonDefaultId;
  if (collapse) {
    return {
      reelRemap: [
        {
          sql: `UPDATE pending_capture SET collection_id=? WHERE user_id=? AND collection_id=?`,
          params: [accountDefaultId, anonId, anonDefaultId],
        },
      ],
      collectionOps: [
        {
          sql: `UPDATE collections SET user_id=? WHERE user_id=? AND id<>?`,
          params: [accountId, anonId, anonDefaultId],
        },
        { sql: `DELETE FROM collections WHERE id=?`, params: [anonDefaultId] },
      ],
    };
  }
  return {
    reelRemap: [],
    collectionOps: [{ sql: `UPDATE collections SET user_id=? WHERE user_id=?`, params: [accountId, anonId] }],
  };
}

// Turn merge ops into D1 statements. Re-point and delete both guard on the anon
// owner so a replayed merge is a no-op (idempotent) and never touches another
// owner's rows (non-destructive).
export function buildPendingStatements(
  ops: MergeOp[],
  accountId: string,
  anonId: string,
): Stmt[] {
  const setClause = MERGE_FIELDS.map((f) => `${f}=?`).join(", ");
  const stmts: Stmt[] = [];
  for (const op of ops) {
    if (op.kind === "repoint") {
      stmts.push({
        sql: `UPDATE pending_capture SET user_id=? WHERE id=? AND user_id=?`,
        params: [accountId, op.id, anonId],
      });
    } else {
      stmts.push({
        sql: `UPDATE pending_capture SET ${setClause} WHERE id=?`,
        params: [...MERGE_FIELDS.map((f) => op.fields[f]), op.keepId],
      });
      stmts.push({
        sql: `DELETE FROM pending_capture WHERE id=? AND user_id=?`,
        params: [op.deleteId, anonId],
      });
    }
  }
  return stmts;
}
