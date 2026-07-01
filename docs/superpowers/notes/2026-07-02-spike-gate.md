# Phase 0 Spike — Gate Decision (PRD 08 Accounts)

**Date:** 2026-07-02
**Plan:** `docs/superpowers/plans/2026-07-02-accounts.md` (Task 0.6)
**Branch:** `feat/accounts-prd08`

## Decision: ✅ PASS — proceed with Better Auth

The Task Zero criteria are all met. Better Auth + D1 works on the Worker with no
fight that threatens the foundation. **The Auth.js fallback is not needed.**
Phases 1–4 may now be expanded into exact-code TDD against the observed API
(recorded below).

## Gate criteria — results

| Criterion | Result |
|---|---|
| D1 adapter works without fighting | ✅ via `kysely-d1` `D1Dialect` (no native D1 adapter in better-auth) |
| Google round-trip completes | ✅ sign-in → Google consent → callback → session |
| Session resolves server-side with usable user id | ✅ `get-session` returns full `{ session, user }` |
| Data persists in D1 | ✅ `user`, `session`, `account` rows all written |
| Session cookie durable | ✅ 7-day expiry; HttpOnly; SameSite=Lax |

Verified live at `wrangler dev`: `user` (id/email/`emailVerified=1`), `session`
(FK `userId`, token, `expiresAt` = createdAt + 7d), `account`
(`providerId='google'`, Google `accountId` sub, FK `userId`).

## Observed API surface (Phase 1 consumes this)

- **Auth stack:** `better-auth@1.6.23`; CLI installed on demand via `npx @better-auth/cli@latest`.
- **Owner id for the trust rule = `session.userId`.**
- **Routes:**
  - `POST /api/auth/sign-in/social` — body `{ provider, callbackURL }` → `{ url, redirect:true }`; sets `better-auth.state` PKCE cookie (Max-Age 300, HttpOnly, SameSite=Lax). Flow **must be browser-initiated** so that cookie lands same-origin.
  - `GET /api/auth/callback/google` — Google redirect target (PKCE, `redirect_uri=<AUTH_BASE_URL>/api/auth/callback/google`).
  - `GET /api/auth/get-session` — `200` + `{ session, user }` when authed, `200` + `null` when not (no DB hit without a cookie).
  - `POST /api/auth/sign-out` — available (not live-tested; verify in Phase 1).
- **Session object shape:** `{ id, token, userId, expiresAt, createdAt, updatedAt, ipAddress, userAgent }`.
- **User object shape:** `{ id, name, email, emailVerified, image, createdAt, updatedAt }`.
- **Storage encodings that work as-is:** `date` fields stored as ISO strings in `DATE` columns; `boolean` as `INTEGER` (0/1).

## Findings / friction resolved during the spike

1. **No native D1 adapter.** better-auth's only Cloudflare references are its
   Turnstile captcha plugin. Bridged to D1 via `kysely-d1` `D1Dialect` over the
   Kysely instance better-auth already bundles. `kysely-d1@0.4.0` peer-deps
   `kysely: '*'`, so no version conflict with the bundled `kysely@0.29.2`.
2. **`nodejs_compat` required.** better-auth (and the existing web-push lib)
   import `node:crypto` / `node:async_hooks`. Added `compatibility_flags =
   ["nodejs_compat"]` to `wrangler.toml`.
3. **Entry-module export validation.** Under `nodejs_compat` the runtime
   validates every *named export* of the entry module as an entrypoint and
   rejects non-function values. The two SQL string consts (`UPSERT_SQL`,
   `COLLECTIONS_UPSERT_SQL`) were moved to `worker/sql.ts`; the two consuming
   tests updated. Exported *functions* remain fine.
4. **Schema generation.** `@better-auth/cli generate` needs a live SQLite it can
   introspect (it diffs existing tables); a stub D1 has no `.prepare`, so the
   headless CLI path fails. Schema was instead derived from the library's own
   `getAuthTables()` + its migration type map (string→TEXT, boolean→INTEGER,
   date→DATE, id→TEXT) and appended to `schema.sql`.

## Follow-ups for later phases (carry into Phase 1+)

- **🔐 Rotate the Google client secret before public release.** The dev secret
  was shared in plaintext during the spike (now only in gitignored `.dev.vars`).
  Rotate it and set the production value via `wrangler secret put
  GOOGLE_CLIENT_SECRET`. (Phase 4 hardening.)
- **Apple provider + "Sign in with Apple"** obligation given Google is offered;
  handle Apple's one-time name/email. (Phase 1 / §13.)
- **Production `AUTH_BASE_URL` + redirect URIs** for Google (and Apple). (Phase 4.)
- **Live sign-out verification** on-device. (Phase 1.)
- **iOS PWA session persistence** on-device (the flaky bit). (Phase 4 / §13.)
- **Dev tooling (non-blocking):** `wrangler@3.114` is behind v4; `npm audit`
  reports vulns in wrangler's transitive deps (not better-auth). Separate from
  this work; upgrade is a breaking change.

## Artifacts produced by Phase 0

- `worker/auth.ts` — `createAuth(env)` factory (D1 via kysely-d1, Google provider).
- `worker/sql.ts` — extracted sync SQL consts.
- `schema.sql` — Better Auth `user`/`session`/`account`/`verification` tables.
- `wrangler.toml` — `nodejs_compat`, `AUTH_BASE_URL`, `GOOGLE_CLIENT_ID`.
- `tests/auth-spike.test.ts` — wiring tripwire.
- `.dev.vars` (gitignored) — local `GOOGLE_CLIENT_SECRET`.
