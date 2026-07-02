import { describe, it, expect } from "vitest";
import { handleMerge } from "../worker/index";

// A DB that fails the test if merge logic ever touches it — proves the auth
// gate and no-op branches short-circuit before any database work.
const explodingDB = {
  prepare() {
    throw new Error("DB must not be touched");
  },
  batch() {
    throw new Error("DB must not be touched");
  },
} as any;

const req = (body: unknown) =>
  new Request("http://x/api/merge", { method: "POST", body: JSON.stringify(body) });

describe("handleMerge auth gate", () => {
  it("returns 401 when not signed in", async () => {
    const anon = async () => null;
    const res = await handleMerge(req({ anon_id: "anonX" }), { DB: explodingDB } as any, anon);
    expect(res.status).toBe(401);
  });

  it("no-ops when no anon_id is supplied", async () => {
    const authed = async () => ({ user: { id: "acct1" } });
    const res = await handleMerge(req({}), { DB: explodingDB } as any, authed);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, merged: 0 });
  });

  it("no-ops when the anon_id already is the account (re-run)", async () => {
    const authed = async () => ({ user: { id: "acct1" } });
    const res = await handleMerge(req({ anon_id: "acct1" }), { DB: explodingDB } as any, authed);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, merged: 0 });
  });
});
