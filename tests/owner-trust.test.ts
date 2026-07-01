import { describe, it, expect } from "vitest";
import { resolveOwner, type SessionInfo } from "../worker/owner";

// A session reader that always returns the given session (or null).
const reader = (session: SessionInfo | null) => async () => session;
const H = new Headers();

describe("resolveOwner (trust rule)", () => {
  it("uses the session account id when signed in", async () => {
    const r = await resolveOwner(reader({ user: { id: "acct1" } }), H, "anonX");
    expect(r).toEqual({ ownerId: "acct1", authed: true });
  });

  it("ignores a spoofed client user_id when signed in", async () => {
    const r = await resolveOwner(reader({ user: { id: "acct1" } }), H, "victimAnon");
    expect(r.ownerId).toBe("acct1");
    expect(r.authed).toBe(true);
  });

  it("falls back to the claimed anon id when not signed in", async () => {
    const r = await resolveOwner(reader(null), H, "anonX");
    expect(r).toEqual({ ownerId: "anonX", authed: false });
  });

  it("yields a null owner when anonymous and no id is claimed", async () => {
    const r = await resolveOwner(reader(null), H, null);
    expect(r).toEqual({ ownerId: null, authed: false });
  });

  it("treats an empty/missing session user id as anonymous", async () => {
    const r = await resolveOwner(reader({ user: { id: "" } }), H, "anonX");
    expect(r).toEqual({ ownerId: "anonX", authed: false });
  });
});
