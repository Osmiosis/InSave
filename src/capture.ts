import { parse } from "./url-normalize";
import type { CaptureResult, CaptureSource, PendingCapture, SharePayload } from "./types";
import type { PendingStore } from "./pending-store";

export interface CaptureDeps {
  now: () => number;
  uuid: () => string;
}

const defaultDeps: CaptureDeps = {
  now: () => Date.now(),
  uuid: () => crypto.randomUUID(),
};

export async function handleCapture(
  payload: SharePayload,
  store: PendingStore,
  source: CaptureSource = "share_target",
  deps: CaptureDeps = defaultDeps,
): Promise<CaptureResult> {
  const { canonicalUrl, parseOk } = parse(payload);

  if (parseOk) {
    const existing = await store.getByCanonicalUrl(canonicalUrl);
    if (existing) return { status: "dup", record: existing };
  }

  const record: PendingCapture = {
    id: deps.uuid(),
    canonical_url: canonicalUrl,
    raw_payload: JSON.stringify(payload),
    captured_at: deps.now(),
    source,
    status: "pending",
    parse_ok: parseOk,
    synced: false,
  };

  try {
    await store.put(record);
  } catch {
    return { status: "error" };
  }

  return { status: parseOk ? "saved" : "unparsed", record };
}
