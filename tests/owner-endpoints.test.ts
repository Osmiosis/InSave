import { describe, it, expect } from "vitest";
import { handleSync, handlePull, handleSubscribe } from "../worker/index";
import { toBind } from "../worker/index";

// Minimal D1 stub that records every bound statement's args.
function mockDB() {
  const binds: unknown[][] = [];
  const stmt = {
    bind(...args: unknown[]) {
      binds.push(args);
      return {
        run: async () => ({ success: true }),
        first: async () => null,
        all: async () => ({ results: [] }),
      };
    },
  };
  return { binds, prepare: (_sql: string) => stmt } as any;
}

const record = (userId: string) => ({
  id: "r1", canonical_url: "u1", raw_payload: "{}", captured_at: 1,
  source: "share", status: "pending", parse_ok: true, user_id: userId,
});
// user_id is index 16 in toBind's positional args.
const USER_ID_IDX = toBind(record("x")).indexOf("x");

describe("trust rule applied to endpoints", () => {
  it("handleSync re-owns records to the session account, ignoring body user_id", async () => {
    const db = mockDB();
    const req = new Request("http://x/api/sync", {
      method: "POST",
      body: JSON.stringify([record("spoofed-anon")]),
    });
    const authed = async () => ({ user: { id: "acct1" } });
    const res = await handleSync(req, { DB: db } as any, authed);
    expect(res.status).toBe(200);
    expect(db.binds[0][USER_ID_IDX]).toBe("acct1");
  });

  it("handleSync keeps the client user_id when anonymous", async () => {
    const db = mockDB();
    const req = new Request("http://x/api/sync", {
      method: "POST",
      body: JSON.stringify([record("anon1")]),
    });
    const anon = async () => null;
    await handleSync(req, { DB: db } as any, anon);
    expect(db.binds[0][USER_ID_IDX]).toBe("anon1");
  });

  it("handlePull reads the session account's items, ignoring query user_id", async () => {
    const db = mockDB();
    const url = new URL("http://x/api/pull?user_id=victim");
    const authed = async () => ({ user: { id: "acct1" } });
    const res = await handlePull(new Request(url), url, { DB: db } as any, authed);
    expect(res.status).toBe(200);
    // listByUser binds the owner id as the first (only) parameter.
    expect(db.binds[0][0]).toBe("acct1");
  });

  it("handlePull reads the claimed anon id when not signed in", async () => {
    const db = mockDB();
    const url = new URL("http://x/api/pull?user_id=anon1");
    const anon = async () => null;
    await handlePull(new Request(url), url, { DB: db } as any, anon);
    expect(db.binds[0][0]).toBe("anon1");
  });

  it("handleSubscribe owns a signed-in device's subscription to the account (§7.6)", async () => {
    const db = mockDB();
    const req = new Request("http://x/api/subscribe", {
      method: "POST",
      body: JSON.stringify({
        user_id: "spoofed-anon",
        subscription: { endpoint: "https://push/ep", keys: { p256dh: "p", auth: "a" } },
      }),
    });
    const authed = async () => ({ user: { id: "acct1" } });
    const res = await handleSubscribe(req, { DB: db } as any, authed);
    expect(res.status).toBe(200);
    // putSubscription binds (endpoint, user_id, p256dh, auth, created_at).
    expect(db.binds[0][1]).toBe("acct1");
  });
});
