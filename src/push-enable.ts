import { VAPID_PUBLIC_KEY, urlBase64ToUint8Array } from "./push-config";
import { getUserId } from "./db";

const btn = document.getElementById("enable-reminders") as HTMLButtonElement | null;

async function enable(): Promise<void> {
  if (!btn) return;
  btn.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      btn.textContent = "Reminders blocked";
      btn.disabled = false;
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      // Cast across TS's generic Uint8Array<ArrayBufferLike> vs BufferSource (ArrayBuffer-backed).
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    });
    const user_id = await getUserId();
    await fetch("/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id, subscription: sub.toJSON() }),
    });
    btn.textContent = "Reminders on ✓";
  } catch {
    btn.textContent = "Couldn't enable — try again";
    btn.disabled = false;
  }
}

btn?.addEventListener("click", () => {
  void enable();
});
