export interface SharePayload {
  url?: string;
  text?: string;
  title?: string;
}

export type CaptureSource = "share_target" | "import" | "shortcut" | "clipboard";
export type CaptureStatus = "pending" | "tagged" | "dismissed";

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
  importance?: "normal" | "matters";
  tagged_at?: number;    // epoch ms, set on transition to "tagged"
  // Carried from backlog import at promote time; null for share-captures.
  author?: string;
  media_type?: "reel" | "post";
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

export type { PendingStore } from "./pending-store";
