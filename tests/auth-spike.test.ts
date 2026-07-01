import { describe, it, expect } from "vitest";
import { createAuth } from "../worker/auth";

// Wiring tripwire for the Better Auth mount (Phase 0 spike). A get-session
// request with no session cookie short-circuits to null before Better Auth
// touches the database, so a stub DB binding is sufficient here. The real
// D1 read/write path is validated by the live Google round-trip (Task 0.4).
const TEST_ENV = {
  DB: {} as unknown as D1Database,
  AUTH_BASE_URL: "http://localhost:8787",
  GOOGLE_CLIENT_ID: "test",
  GOOGLE_CLIENT_SECRET: "test",
};

describe("better-auth wiring (spike)", () => {
  it("serves an unauthenticated session as null", async () => {
    const auth = createAuth(TEST_ENV);
    const res = await auth.handler(
      new Request("http://localhost:8787/api/auth/get-session"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session?: unknown } | null;
    expect(body?.session ?? null).toBeNull();
  });
});
