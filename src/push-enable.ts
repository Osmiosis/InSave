import { ensureSubscription } from "./push-subscribe";

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
    await ensureSubscription();
    btn.textContent = "Reminders on ✓";
  } catch {
    btn.textContent = "Couldn't enable — try again";
    btn.disabled = false;
  }
}

btn?.addEventListener("click", () => {
  void enable();
});
