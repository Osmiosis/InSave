CREATE TABLE IF NOT EXISTS pending_capture (
  id            TEXT PRIMARY KEY,
  canonical_url TEXT,
  raw_payload   TEXT NOT NULL,
  captured_at   INTEGER NOT NULL,
  source        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  parse_ok      INTEGER NOT NULL DEFAULT 1,
  saved_at      INTEGER,
  title         TEXT,
  thumbnail     TEXT,
  description   TEXT,
  topic_tags    TEXT,
  importance    TEXT,
  tagged_at     INTEGER,
  author        TEXT,
  media_type    TEXT,
  user_id          TEXT,
  reminder_status  TEXT,
  next_due_at      INTEGER,
  cycle_count      INTEGER,
  ignored_count    INTEGER,
  last_surfaced_at INTEGER
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id          TEXT PRIMARY KEY,
  quiet_start      INTEGER,
  quiet_end        INTEGER,
  timezone         TEXT,
  cadence          TEXT,
  reminders_paused INTEGER,
  last_digest_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_due
  ON pending_capture (user_id, reminder_status, next_due_at);

-- Dedupe key. Partial unique index so multiple parse_ok=false rows
-- (canonical_url = '') don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_url
  ON pending_capture (canonical_url)
  WHERE canonical_url <> '';
