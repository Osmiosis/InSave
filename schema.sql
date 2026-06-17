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
  description   TEXT
);

-- Dedupe key. Partial unique index so multiple parse_ok=false rows
-- (canonical_url = '') don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_url
  ON pending_capture (canonical_url)
  WHERE canonical_url <> '';
