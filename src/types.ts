export interface SharePayload {
  url?: string;
  text?: string;
  title?: string;
}

export type CaptureSource = "share_target" | "import" | "shortcut" | "clipboard";
export type CaptureStatus = "pending" | "tagged" | "dismissed";
export type ReminderStatus = "active" | "snoozed" | "done" | "expired";
export type Importance = "normal" | "matters";
export type Cadence = "often" | "balanced" | "rarely";

export interface PendingCapture {
  id: string;            // client-generated UUID
  canonical_url: string; // dedupe key ("" when parse_ok is false and no URL recovered)
  raw_payload: string;   // JSON.stringify of the original SharePayload
  captured_at: number;   // epoch ms
  source: CaptureSource;
  status: CaptureStatus;
  parse_ok: boolean;
  synced: boolean;       // local-only flag, not sent to backend as a column
  // Import metadata / enrichment seam (undefined for share-captures).
  saved_at?: number;
  title?: string;
  thumbnail?: string;
  description?: string;
  // Tag Queue (PRD 03). Undefined until the item is tagged.
  topic_tags?: string[];
  importance?: Importance;
  tagged_at?: number;    // epoch ms, set on transition to "tagged"
  // Collections (PRD 05). null/undefined ≡ the user's "Saved" collection.
  collection_id?: string;
  // Carried from backlog import at promote time; null for share-captures.
  author?: string;
  media_type?: "reel" | "post";
  // Reminder engine (PRD 04). Server-owned (cron is the sole writer); absent until tagged.
  user_id?: string;
  reminder_status?: ReminderStatus;
  next_due_at?: number;
  cycle_count?: number;
  ignored_count?: number;
  last_surfaced_at?: number;
}

export type CaptureOutcome = "saved" | "dup" | "unparsed" | "error";

export interface CaptureResult {
  status: CaptureOutcome;
  record?: PendingCapture;
}

export type BacklogState = "dormant" | "promoted";

export interface ParsedSavedItem {
  url: string;
  author: string;
  savedAt: number; // epoch ms (converted from the export's seconds)
  caption?: string;
  mediaType: "reel" | "post";
}

export interface ImportedItem {
  id: string;
  canonical_url: string;
  author: string;
  saved_at: number;    // original Instagram save timestamp, epoch ms
  imported_at: number; // when InSave ingested it, epoch ms
  raw_payload: string; // JSON of the raw export entry
  parse_ok: boolean;
  backlog_state: BacklogState;
  caption?: string;
  media_type: "reel" | "post";
}

export interface EnrichmentResult {
  title?: string;
  thumbnail?: string;
  description?: string;
}

export interface UserSettings {
  user_id: string;
  quiet_start: number;   // local hour 0-23
  quiet_end: number;     // local hour 0-23
  timezone: string;      // IANA tz
  cadence: Cadence;
  reminders_paused: boolean;
  last_digest_at?: number;
  synced: boolean;       // local-only
}

export interface Collection {
  id: string;            // client-generated UUID
  user_id: string;
  name: string;
  created_at: number;    // epoch ms
  is_default: boolean;   // true ONLY for the per-user "Saved" collection
  synced: boolean;       // local-only flag, not a wire/D1 column
}

export type { PendingStore } from "./pending-store";
