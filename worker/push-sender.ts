export interface PushSubscriptionRecord {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
  created_at: number;
}

export interface PushSender {
  // Sends one encrypted push. `gone` means the endpoint is dead (404/410) and should be pruned.
  send(sub: PushSubscriptionRecord, payload: string): Promise<{ ok: boolean; gone: boolean }>;
}
