import { betterAuth } from "better-auth";
import { D1Dialect } from "kysely-d1";

// Config Better Auth needs, sourced from the Worker env. Kept as its own
// interface so the auth layer doesn't depend on the full Worker Env shape.
export interface AuthEnv {
  DB: D1Database;
  AUTH_BASE_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

// Better Auth ships no native D1 adapter, so we bridge to D1 through the
// kysely-d1 dialect over the bundled Kysely (see spike gate note). The
// instance is created per-request in the Worker; D1 bindings are only valid
// inside a request/scheduled scope.
export function createAuth(env: AuthEnv) {
  return betterAuth({
    database: {
      dialect: new D1Dialect({ database: env.DB }),
      type: "sqlite",
    },
    baseURL: env.AUTH_BASE_URL,
    basePath: "/api/auth",
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
