import { assemblePayload } from "../src/reminder/payload";
import type { Notify } from "./cron";
import type { ReminderRepo } from "./reminder-repo";
import type { PushSender } from "./push-sender";

export function makeNotify(repo: ReminderRepo, sender: PushSender): Notify {
  return async (userId, due) => {
    const subs = await repo.listSubscriptions(userId);
    if (subs.length === 0) return;
    const payload = assemblePayload(due);
    for (const sub of subs) {
      const res = await sender.send(sub, payload);
      if (res.gone) await repo.deleteSubscription(sub.endpoint);
    }
  };
}
