export interface SharePayload {
  url?: string;
  text?: string;
  title?: string;
}

export type CaptureSource = "share_target" | "import" | "shortcut" | "clipboard";
export type CaptureStatus = "pending";

export interface PendingCapture {
  id: string;            // client-generated UUID
  canonical_url: string; // dedupe key ("" when parse_ok is false and no URL recovered)
  raw_payload: string;   // JSON.stringify of the original SharePayload
  captured_at: number;   // epoch ms
  source: CaptureSource;
  status: CaptureStatus;
  parse_ok: boolean;
  synced: boolean;       // local-only flag, not sent to backend as a column
}

export type CaptureOutcome = "saved" | "dup" | "unparsed" | "error";

export interface CaptureResult {
  status: CaptureOutcome;
  record?: PendingCapture;
}

export type { PendingStore } from "./pending-store";
