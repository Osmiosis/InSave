import { buildPushPayload, type PushSubscription, type VapidKeys } from "@block65/webcrypto-web-push";
import type { PushSender, PushSubscriptionRecord } from "./push-sender";

// The ONLY file that touches the web-push library. Maps a dead endpoint (404/410) to `gone`.
export function makeWebPushSender(vapid: VapidKeys): PushSender {
  return {
    async send(sub: PushSubscriptionRecord, payload: string) {
      const subscription: PushSubscription = {
        endpoint: sub.endpoint,
        expirationTime: null,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      const init = await buildPushPayload({ data: payload, options: { ttl: 60 } }, subscription, vapid);
      // The library returns a Uint8Array body, valid at runtime but not in the Workers
      // `RequestInit.body` (BodyInit) type — cast across the typing gap.
      const res = await fetch(sub.endpoint, init as unknown as RequestInit);
      return { ok: res.ok, gone: res.status === 404 || res.status === 410 };
    },
  };
}
