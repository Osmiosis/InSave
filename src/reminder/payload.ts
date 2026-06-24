import type { PendingCapture } from "../types";

// Shared notification payload (worker builds it; the service worker renders + acts on it).
export function assemblePayload(userId: string, due: PendingCapture[]): string {
  const count = due.length;
  const body = count === 1 ? "1 reel worth revisiting" : `${count} reels worth revisiting`;
  return JSON.stringify({ title: "InSave", body, count, user_id: userId, ids: due.map((d) => d.id) });
}
