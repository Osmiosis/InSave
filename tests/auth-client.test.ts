import { describe, it, expect, vi, afterEach } from "vitest";
import { getSession, signInGoogle, signOut, deleteAccount } from "../src/auth-client";

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}
const json = (body: unknown, ok = true) =>
  Promise.resolve({ ok, json: async () => body } as Response);

afterEach(() => vi.unstubAllGlobals());

describe("auth-client", () => {
  it("getSession returns the session when signed in", async () => {
    stubFetch(() => json({ user: { id: "acct1", name: "Aarav", email: "a@x.com" } }));
    const s = await getSession();
    expect(s?.user.id).toBe("acct1");
  });

  it("getSession returns null when there is no session", async () => {
    stubFetch(() => json(null));
    expect(await getSession()).toBeNull();
  });

  it("getSession returns null on a non-OK response", async () => {
    stubFetch(() => json({ user: { id: "x" } }, false));
    expect(await getSession()).toBeNull();
  });

  it("getSession returns null when fetch throws", async () => {
    stubFetch(() => Promise.reject(new Error("offline")));
    expect(await getSession()).toBeNull();
  });

  it("signInGoogle posts the provider and navigates to the returned url", async () => {
    const fetchFn = stubFetch(() => json({ url: "https://accounts.google.com/o/oauth2/v2/auth?x" }));
    const navigated: string[] = [];
    await signInGoogle("/", (u) => navigated.push(u));
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("/api/auth/sign-in/social");
    expect(JSON.parse(String(init?.body))).toMatchObject({ provider: "google", callbackURL: "/" });
    expect(navigated).toEqual(["https://accounts.google.com/o/oauth2/v2/auth?x"]);
  });

  it("signOut posts to the sign-out route", async () => {
    const fetchFn = stubFetch(() => json({ ok: true }));
    await signOut();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("/api/auth/sign-out");
    expect(init?.method).toBe("POST");
    // Better Auth POST routes need a JSON content-type AND a parseable body.
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(() => JSON.parse(String(init?.body))).not.toThrow();
  });

  it("deleteAccount posts to the delete endpoint and returns ok", async () => {
    const fetchFn = stubFetch(() => json({ ok: true }));
    const ok = await deleteAccount();
    expect(ok).toBe(true);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("/api/account/delete");
    expect(init?.method).toBe("POST");
  });

  it("deleteAccount returns false on a non-OK response", async () => {
    stubFetch(() => json({}, false));
    expect(await deleteAccount()).toBe(false);
  });
});
