# Design: Accounts — optional login & cross-context sync (PRD 08)

**Date:** 2026-07-02
**Source PRD:** `PRD's/08-accounts.md`
**Status:** Approved design — ready for implementation planning
**Context:** Public release intended. Multi-tenant correctness, auth trust model, and data safety are first-class, not deferred.

---

## 1. Problem

InSave has no notion of a user. Every browser context mints its own anonymous `user_id` (client-side, `crypto.randomUUID()`, stored in IndexedDB `meta`) and passes it — **unverified** — in request bodies/query strings. One real person therefore fragments into multiple "users" in production D1 (Android share-target, iPhone Safari, iPhone PWA). On iOS the Shortcut captures into Safari's storage sandbox, separate from the installed PWA, so a captured reel lands under "Safari-you" and never appears in the app or gets reminders.

Accounts are the real fix: an optional, verified identity that reconciles these islands into one library. This unblocks the iPhone capture story, enables multi-device, and makes data survive a new phone.

## 2. Goals

1. Optional Google / Apple sign-in; anonymous use remains fully functional without it.
2. First sign-in absorbs the device's anonymous data into the account — nothing lost.
3. Signing into the same account on another context reconciles libraries into an additive, deduped union.
4. The iPhone Shortcut path works once signed in on **both** app and Safari.
5. Data restores after reinstall / new phone by signing in.
6. **No regression** to the anonymous fast path (capture, sync, cron reminders, collections, importance/deadline) signed-out.

## 3. Non-goals

- Required login / signup walls anywhere.
- Email/password or magic-link auth.
- The PRD-07 §8 token-carrying silent Shortcut / native app (subsumed by accounts; stays demand-driven).
- Account management beyond essentials (v1 = sign in, sign out, merge, delete-account).
- Social / shared collections or multi-user collaboration.
- Collection dedupe-by-name (cosmetic; possible later polish).
- The reminder timezone bug (tracked separately).

## 4. Settled decisions (from brainstorming)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Deliverable scope | Full system design, staged plan, **spike is a hard gate (Phase 0)** | "Finish PRD08" = approved spec + buildable staged plan; spike outcome can change foundation |
| D2 | Owner-reference mechanism | **Re-point rows** (server-side re-key), not an anon→account map table | Every existing read path keys on a raw `user_id` string and keeps working unchanged; naturally idempotent; matches PRD §7.2 |
| D3 | `canonical_url` dedupe scope | **User-scoped** `(user_id, canonical_url)`, not global | Public release → fix latent cross-user ownership quirk; defensible multi-tenant story. Cost: merge collisions become expected → merge dedupe must be bulletproof (designed for below) |
| D4 | Field precedence on colliding reel | Server-owned reminder state = account authoritative; device-owned content = **additive coalesce**, `tagged_at` breaks genuine conflicts | Satisfies §6.2 "MUST NOT silently drop a user's choice" |
| D5 | Auth trust model | **Owner id derived from verified session** when signed in; anon path stays unverified | Release blocker: otherwise a signed-in user reads/writes another account by spoofing `user_id` in the body |
| D6 | Auth stack | **Better Auth** in-Worker, D1 adapter; Auth.js fallback evaluated at spike if D1 adapter fights | Free, self-hosted, identities in our DB (PRD §1) |

## 5. Architecture

Better Auth mounted in the existing **raw** Cloudflare Worker (`worker/index.ts`) at `/api/auth/*`; `user` / `session` / `account` / `verification` tables in D1 alongside the current four tables. The client gains a thin auth layer (sign-in buttons, session state) but **the anonymous fast path is untouched** — login is purely an ownership upgrade.

Routing: add a small `/api/auth/*` branch to the existing manual dispatch (`worker/index.ts:128-149`) rather than introduce Hono, keeping the review surface small. If Better Auth's handler ergonomics push hard toward a router, that is flagged at spike time — not assumed now.

### 5.1 Auth & session

- Better Auth in-Worker, D1 adapter, Google + Apple providers.
- Durable session cookie (sticky login, PRD §7.1): HttpOnly, Secure, SameSite=Lax, long expiry.
- Apple's one-time name/email-on-first-auth return persisted on first sign-in.

### 5.2 The trust rule (release-critical)

One shared owner-id resolver applied at the top of every `/api/*` data handler (`handleSync`, `handlePull`, `handleCollections`, `handleSubscribe`, `parseAction`):

- **Session present** → owner id = account id **from the session**. Any `user_id` in the body/query is ignored; if present and mismatched, respond 403.
- **No session** → anonymous path unchanged: owner id = the client-supplied `user_id` (unverified, exactly as today).

Centralized, small, testable. This is the single most load-bearing change for a public release.

## 6. Identity model

- Owner column stays `user_id` on the four existing tables. It now holds **either** an anon UUID **or** a Better Auth account id — both opaque strings, so those columns need no schema change.
- The re-point mechanism means **no separate anon→account map table**. On merge, rows are re-keyed from the anon id to the account id.
- Existing sync (PRD 01/04c) keys on "the current owner id" and therefore keeps working through the transition without forking.

## 7. Merge engine (the heart)

### 7.1 Trigger & flow

When a user signs in on a context holding anon data, once the session is established the client POSTs its stored anon `user_id` to a new **`POST /api/merge`**, authenticated by the session. The server derives `account_id` from the session (never trusts the body for that), treats the body's anon id as the source to absorb, does all the work server-side; the client then swaps its IndexedDB `user_id` to `account_id` and re-pulls.

### 7.2 Per anon id, in a single atomic D1 batch

- **`pending_capture`**, per anon row:
  - **No collision** (account doesn't already own that `canonical_url`) → `UPDATE ... SET user_id = account_id`. Pure re-point.
  - **Collision** (account already owns that `canonical_url` — now *expected* under user-scoped dedupe) → resolve field precedence **into the surviving account row**, then delete the redundant anon row (content already absorbed).
- **`collections`** → re-point by `user_id`. Collection ids are stable client UUIDs, so `pending_capture.collection_id` references stay valid.
- **`user_settings`** → account's row wins if it exists; adopt the anon row only if the account has none (PK is `user_id`).
- **`push_subscriptions`** → re-point by `user_id`; if the same `endpoint` already exists under the account, keep the account's (§7.6 of PRD).

### 7.3 Field precedence on a colliding reel

- **Server-owned reminder state** (`reminder_status`, `next_due_at`, `cycle_count`, `ignored_count`, `last_surfaced_at`) → **account's values always win**; never touched by merge. Stops a re-merge from resurrecting a retired reminder or double-scheduling. Consistent with the existing disjoint-ownership model (cron is sole writer; `worker/index.ts:74-85` UPSERT already excludes these columns; client `src/reminder/reconcile-pull.ts` treats remote as authoritative for exactly these).
- **Device-owned content** (`status`, `description`, `author`, `media_type`, `importance`, `topic_tags`, `collection_id`, `deadline_at`, `tagged_at`) → **additive coalesce**: if the account row's field is empty and the anon row has a value, take the anon value (never lose a user's tag/collection/deadline choice). If both are set and differ, the row with the newer `tagged_at` wins the tagging cluster; `deadline_at` keeps whichever is set (newer wins).

### 7.4 Idempotency, safety, resilience

- **Idempotent:** after merge, anon rows are gone (re-pointed or absorbed-then-deleted); a replayed `/api/merge` with the same anon id is a no-op.
- **Non-destructive:** every branch either keeps the account row or re-points the anon row. The only deletes are redundant duplicates whose content was already coalesced into the survivor — no reel is ever dropped (§6.3).
- **Interruption-resilient:** the whole per-anon-id merge is one atomic D1 batch. Fail → nothing commits → client safely retries (idempotent).

### 7.5 Multi-context reconciliation (free)

Sign in on Safari, then the app, then Android — each context runs `/api/merge` with *its* anon id against the *same* account. The result is the additive, deduped union of all islands. This is the §3 iPhone fix and multi-device convergence in one mechanism.

### 7.6 Merge threat model

Absorbing an anon id is safe because anon ids are unguessable 128-bit random UUIDs never exposed cross-user (knowing one implies device access). Documented as the mitigation. Combined with idempotent + non-destructive merge, a replayed or malformed merge cannot corrupt a library.

## 8. iOS onboarding (`ios.html`, PRD 07b)

Adds the two-context truth as a real design element (PRD §3, §7.5):

- **No account needed:** *Paste a reel link* inside the installed app → captured in the app's own sandbox, reminded today, zero login. The default zero-friction path.
- **Want the one-tap Shortcut?** Sign in (Google/Apple) **on both the installed app and Safari** → the Shortcut's Safari-captured reels reconcile into the account and appear in the app with reminders.
- The "sign in on **both** contexts" requirement gets explicit, understandable copy — it is genuinely non-obvious and is the thing users will get wrong.

## 9. Push subscriptions across identity change (PRD §7.6)

`push_subscriptions` re-points during merge, so a signed-in account's devices keep receiving reminders and a merged-away anon id stops being targeted. The existing `ensureSubscription()` (called on every app open, `src/register-sw.ts:11`) already re-registers; after merge it registers under the account id. No new client rail. Test: a subscription follows the merge, and the dead anon id receives no sends.

## 10. Data model, migration & deletion

### 10.1 Schema additions

- Better Auth `user` / `session` / `account` / `verification` tables in D1, appended to `schema.sql` with `CREATE TABLE IF NOT EXISTS` per the established pattern.
- No column change to the four existing tables' `user_id`.

### 10.2 Dedupe index migration

- Drop the global `idx_canonical_url` (`schema.sql:64-66`); create unique `(user_id, canonical_url) WHERE canonical_url <> ''`.
- Update `handleSync` conflict handling (`worker/index.ts:178-189`) so an existing-row "accepted" response is correctly per-user.

### 10.3 Migration path (release requirement)

`db:init` is `--local` only today with no migrations directory. For a public release, introduce a **repeatable, ordered remote migration path** (a lightweight numbered-migration convention, or at minimum a documented `wrangler d1 execute --remote` sequence) so the index change + Better Auth tables apply to prod without clobbering the real islands. Existing anonymous rows are preserved; the real user merges them by signing in on each island.

### 10.4 Account deletion (PRD §7.1)

`DELETE` account removes the Better Auth records **and** the account's owned rows (`pending_capture`, `collections`, `user_settings`, `push_subscriptions WHERE user_id = account_id`). Data export first is deferred (non-goal).

### 10.5 Release hardening

Production OAuth redirect URIs + consent config for Google & Apple; confirm Apple "Sign in with Apple" obligation given Google is offered; verify iOS PWA session persistence on-device (the flaky bit from PRD §10).

## 11. Phasing (the spike is a real gate)

- **Phase 0 — Task Zero spike (GATE).** Better Auth + D1 adapter + Google round-trip in the Worker: sign in → session cookie → authenticated request → sign out. If the D1 adapter or Worker runtime fights, evaluate the Auth.js fallback **here**, before anything else. Nothing downstream starts until this passes.
- **Phase 1 — Auth foundation.** Apple provider; session middleware; the owner-id-from-session trust rule (§5.2) on existing endpoints; sign-in/out UI; sticky sessions.
- **Phase 2 — Merge engine.** Server-side re-point + user-scoped-dedupe collision resolution + field precedence + idempotency + non-destructiveness (§7). The heart.
- **Phase 3 — iOS onboarding + push re-association.** `ios.html` two-context truth (§8); push subs follow the merge (§9).
- **Phase 4 — Account deletion + release hardening.** Delete-account (§10.4); production OAuth config; on-device session-durability verification (§10.5).

## 12. Acceptance criteria (from PRD §9)

- [ ] Phase 0 spike: Better Auth + D1 + Google round-trip works on the Worker before further build.
- [ ] Sign in with Google and with Apple; anonymous use works fully without signing in.
- [ ] First sign-in absorbs the device's anon reels/collections/settings into the account with nothing lost.
- [ ] Second-context sign-in unions libraries, deduped on `canonical_url`, no duplicates, no resurrected retired reminders.
- [ ] Device-owned content conflicts resolve without silently dropping collection/importance/deadline choices; server-owned reminder state stays account-authoritative.
- [ ] Merge is idempotent (repeat logins don't duplicate or re-resurrect) and non-destructive (no branch deletes reels).
- [ ] iPhone: signing into the same account in Safari and the installed app makes Shortcut-captured reels appear in the app with reminders.
- [ ] Data restores after reinstall / new device by signing in.
- [ ] All anonymous flows still work signed-out.
- [ ] Push subscriptions re-associate on login so reminders reach the account's devices; dead anon id gets no sends.
- [ ] iOS onboarding clearly communicates the paste-vs-Shortcut and sign-in-on-both-contexts truths.
- [ ] **(Release)** Signed-in requests derive owner id from the session; a spoofed body `user_id` cannot access another account's data.

## 13. Build-time verifications (not blocking design)

- Apple SIWA mandate given Google is offered; Apple's one-time name/email handled.
- Better Auth D1 adapter viability on the Worker runtime (resolved in Phase 0; Auth.js fallback if not).
- iOS PWA session persistence on-device.
- Field-precedence rule (§7.3) validated with a real merge test before locking.

## 14. Key code touchpoints

- Identity mint/store: `src/db.ts:44-51` (+ `meta` store `:29`).
- `user_id` call-sites to swap to account id post-merge: `src/pending-store.ts`, `src/collections-store.ts`, `src/push-subscribe.ts`, `src/review-view.ts`, `src/reminder-pull.ts`, `src/sw.ts`.
- Worker dispatch to add `/api/auth/*` + `/api/merge` + apply the trust rule: `worker/index.ts:128-149`.
- Owner-id resolver insertion points: `handleSync`/`handlePull`/`handleCollections`/`handleSubscribe`/`parseAction` in `worker/index.ts`.
- Field-ownership enforcement to preserve through merge: `worker/index.ts:69-85`, `src/reminder/reconcile-pull.ts`.
- Dedupe index + conflict handling: `schema.sql:64-66`, `worker/index.ts:178-189`.
- Merge/re-key seam: `worker/d1-reminder-repo.ts`, `worker/cron.ts:14-20`.
- Cron grouping by `user_id` (must see re-pointed ids): `worker/cron.ts:14-20`.
- iOS onboarding: `ios.html`, `src/ios-onboarding.ts`.

---

*Prev: PRD 07 iPhone Capture. Unblocks: iPhone story, multi-device, data durability. Central hard problem: anonymous→account merge (§7).*
