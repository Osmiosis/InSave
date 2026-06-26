import { VAPID_PUBLIC_KEY, urlBase64ToUint8Array } from "./push-config";
import { getUserId } from "./db";

// Ensures a live push subscription exists and is registered server-side. Safe
// to call repeatedly and on every app open: a no-op unless notifications are
// granted, and it re-subscribes if iOS silently dropped the subscription.
export async function ensureSubscription(): Promise<boolean> {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    });
  }
  const user_id = await getUserId();
  await fetch("/api/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user_id, subscription: sub.toJSON() }),
  });
  return true;
}
