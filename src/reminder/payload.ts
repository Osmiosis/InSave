import type { PendingCapture } from "../types";

// Shared notification payload shape (worker builds it; the service worker renders it).
export function assemblePayload(due: PendingCapture[]): string {
  const count = due.length;
  const body = count === 1 ? "1 reel worth revisiting" : `${count} reels worth revisiting`;
  return JSON.stringify({ title: "InSave", body, count });
}
