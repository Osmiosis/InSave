import { describe, it, expect } from "vitest";
import { parseSubscribe } from "../worker/index";

const good = {
  user_id: "u1",
  subscription: { endpoint: "https://push.example/abc", keys: { p256dh: "PKEY", auth: "AKEY" } },
};

describe("parseSubscribe", () => {
  it("builds a PushSubscriptionRecord from a well-formed body", () => {
    expect(parseSubscribe(good, 1234)).toEqual({
      endpoint: "https://push.example/abc", user_id: "u1", p256dh: "PKEY", auth: "AKEY", created_at: 1234,
    });
  });

  it("returns null when required fields are missing", () => {
    expect(parseSubscribe({ user_id: "u1" }, 0)).toBeNull();
    expect(parseSubscribe({ subscription: good.subscription }, 0)).toBeNull();
    expect(parseSubscribe({ user_id: "u1", subscription: { endpoint: "e", keys: {} } }, 0)).toBeNull();
    expect(parseSubscribe(null, 0)).toBeNull();
  });
});
