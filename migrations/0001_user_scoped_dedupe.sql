-- Migration 0001 — user-scoped canonical_url dedupe (PRD 08 §10.2).
-- Replaces the global unique index on canonical_url with a per-owner one so
-- accounts are multi-tenant-correct and anon→account merges can hold the same
-- reel under different owners until reconciled. Preserves existing rows.
--
-- Apply to a remote/existing D1:
--   wrangler d1 execute insave --remote --file=migrations/0001_user_scoped_dedupe.sql
-- (Fresh local DBs get the final shape straight from schema.sql.)

DROP INDEX IF EXISTS idx_canonical_url;

CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_url
  ON pending_capture (user_id, canonical_url)
  WHERE canonical_url <> '';
