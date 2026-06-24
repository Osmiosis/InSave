import type { CaptureSource, CaptureStatus, Importance, PendingCapture, ReminderStatus } from "../types";

// Rehydrates a raw D1 pending_capture row into a PendingCapture: topic_tags JSON->array,
// parse_ok int->bool, nullable columns -> undefined, synced (local-only) -> true.
export function rowToPending(row: Record<string, unknown>): PendingCapture {
  const num = (v: unknown): number | undefined => (v == null ? undefined : Number(v));
  const str = (v: unknown): string | undefined => (v == null ? undefined : String(v));

  let topic_tags: string[] | undefined;
  if (row.topic_tags != null) {
    try {
      topic_tags = JSON.parse(String(row.topic_tags)) as string[];
    } catch {
      topic_tags = undefined;
    }
  }

  return {
    id: String(row.id),
    canonical_url: String(row.canonical_url ?? ""),
    raw_payload: String(row.raw_payload ?? "{}"),
    captured_at: Number(row.captured_at ?? 0),
    source: String(row.source ?? "import") as CaptureSource,
    status: String(row.status ?? "pending") as CaptureStatus,
    parse_ok: Number(row.parse_ok ?? 0) === 1,
    synced: true,
    saved_at: num(row.saved_at),
    title: str(row.title),
    thumbnail: str(row.thumbnail),
    description: str(row.description),
    topic_tags,
    importance: str(row.importance) as Importance | undefined,
    tagged_at: num(row.tagged_at),
    author: str(row.author),
    media_type: str(row.media_type) as PendingCapture["media_type"],
    user_id: str(row.user_id),
    reminder_status: str(row.reminder_status) as ReminderStatus | undefined,
    next_due_at: num(row.next_due_at),
    cycle_count: num(row.cycle_count),
    ignored_count: num(row.ignored_count),
    last_surfaced_at: num(row.last_surfaced_at),
  };
}
