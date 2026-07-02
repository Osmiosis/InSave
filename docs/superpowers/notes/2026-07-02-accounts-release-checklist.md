# Accounts (PRD 08) — Production Release Checklist

Everything below must be done before deploying the `feat/accounts-prd08` work to
real users. Spec §10.3, §10.5, §13.

## 🔐 Secrets

- [ ] **Rotate the Google client secret.** The dev secret was shared in plaintext
      during the spike; treat it as compromised. Create a new secret in the Google
      Cloud console and set it on the Worker:
      `wrangler secret put GOOGLE_CLIENT_SECRET`
      (Never keep it in `wrangler.toml` — only `.dev.vars` locally, which is gitignored.)

## OAuth configuration (Google)

- [ ] Add the **production redirect URI** to the Google OAuth client:
      `https://<prod-domain>/api/auth/callback/google`
- [ ] Add the production **Authorized JavaScript origin**: `https://<prod-domain>`
- [ ] **Publish the OAuth consent screen** (move it from "Testing" to "In
      production") so any Google user can sign in — while in Testing, only
      explicitly-added test users can.

## Worker config (`wrangler.toml` / vars)

- [ ] Set `AUTH_BASE_URL = "https://<prod-domain>"` (currently `http://localhost:8787`).
      This must match the OAuth redirect origin. With an `https` base URL, Better
      Auth issues **Secure** session cookies automatically (on localhost they are
      not Secure — expected).
- [ ] Set `GOOGLE_CLIENT_ID` to the production value (same client is fine if the
      redirect URIs above cover both dev and prod).
- [ ] Confirm `compatibility_flags = ["nodejs_compat"]` ships to prod (Better Auth
      imports `node:crypto` / `node:async_hooks`).

## Remote D1 migration (preserve existing anon rows)

The production D1 already holds the three real anonymous islands — do NOT clobber
them. Apply in this order:

- [ ] **Create the Better Auth tables** on remote:
      `wrangler d1 execute insave --remote --file=schema.sql`
      (`CREATE TABLE IF NOT EXISTS` — existing app tables are skipped; only
      `user`/`session`/`account`/`verification` are added.)
- [ ] **Swap the dedupe index to user-scoped** (schema.sql's `IF NOT EXISTS` will
      NOT replace the existing global index, so the migration is required):
      `wrangler d1 execute insave --remote --file=migrations/0001_user_scoped_dedupe.sql`
      Safe because the old global index already prevented any duplicate
      `canonical_url`, so no `(user_id, canonical_url)` collisions exist yet.
- [ ] After deploy, the real user signs in on each island (Android, iPhone Safari,
      iPhone app) to merge them into one account (restore-by-login).

## On-device verification (§13)

- [ ] **iOS PWA session persistence** — confirm the 30-day session cookie survives
      closing/reopening the installed home-screen app (iOS PWA cookie persistence
      is historically flaky). Adjust cookie settings if it doesn't stick.
- [ ] Live sign-out on-device returns to signed-out state.
- [ ] Full Google round-trip on the production domain (redirect URI correct).

## Deferred / follow-ups (not release blockers)

- **Apple "Sign in with Apple"** — needs an Apple Developer Program membership
  ($99/yr) + Service ID + key. Not mandated for a PWA (App Store Guideline 4.8 is
  native-only). Purely additive when added: Apple `socialProvider` + a button +
  persist Apple's one-time name/email.
- **`handleAction` owner-scoping** — the reminder-action endpoint keys on an
  unguessable item id, not `user_id`; a signed-in caller could in principle act on
  another account's item if they knew its UUID. Low risk; scope actions to the
  session owner when convenient.
- **Same-name non-default collection dedup** — two devices each with an "AI"
  collection stay as two rows after merge (cosmetic; the default "Saved" IS
  collapsed). Auto-merge by name is a possible later polish.
- **Account data export before deletion** — nice-to-have, deferred (§5 non-goal).
