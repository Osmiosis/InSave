import { describe, it, expect } from "vitest";
import { makeNotify } from "../../worker/notify";
import type { ReminderRepo } from "../../worker/reminder-repo";
import type { PushSender, PushSubscriptionRecord } from "../../worker/push-sender";
import type { PendingCapture } from "../../src/types";

function sub(endpoint: string): PushSubscriptionRecord {
  return { endpoint, user_id: "u1", p256dh: "p", auth: "a", created_at: 0 };
}

function due(): PendingCapture[] {
  return [{
    id: "i", canonical_url: "u", raw_payload: "{}", captured_at: 0,
    source: "import", status: "tagged", parse_ok: true, synced: true,
  }];
}

function fakes(subs: PushSubscriptionRecord[], goneEndpoints: string[] = []) {
  const deleted: string[] = [];
  const sentTo: string[] = [];
  const repo = {
    async listSubscriptions(_u: string) { return subs; },
    async deleteSubscription(endpoint: string) { deleted.push(endpoint); },
  } as unknown as ReminderRepo;
  const sender: PushSender = {
    async send(s, _payload) { sentTo.push(s.endpoint); return { ok: !goneEndpoints.includes(s.endpoint), gone: goneEndpoints.includes(s.endpoint) }; },
  };
  return { repo, sender, deleted, sentTo };
}

describe("makeNotify", () => {
  it("sends the digest to each of the user's subscriptions", async () => {
    const { repo, sender, sentTo } = fakes([sub("e1"), sub("e2")]);
    await makeNotify(repo, sender)("u1", due());
    expect(sentTo.sort()).toEqual(["e1", "e2"]);
  });

  it("makes no send when the user has no subscriptions", async () => {
    const { repo, sender, sentTo } = fakes([]);
    await makeNotify(repo, sender)("u1", due());
    expect(sentTo).toEqual([]);
  });

  it("prunes a subscription the sender reports gone", async () => {
    const { repo, sender, deleted } = fakes([sub("e1"), sub("e2")], ["e2"]);
    await makeNotify(repo, sender)("u1", due());
    expect(deleted).toEqual(["e2"]);
  });

  it("does not prune a merely-failed (not gone) subscription", async () => {
    const { repo, sender, deleted } = fakes([sub("e1")]);
    const failing: PushSender = { async send() { return { ok: false, gone: false }; } };
    await makeNotify(repo, failing)("u1", due());
    expect(deleted).toEqual([]);
    void sender;
  });
});
