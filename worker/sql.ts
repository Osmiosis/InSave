// SQL statements for the sync rails. Kept out of the Worker entry module
// (worker/index.ts) because, under nodejs_compat, the runtime validates every
// named export of the entry module as an entrypoint and rejects non-function
// values like these string constants.

export const UPSERT_SQL = `INSERT INTO pending_capture
   (id, canonical_url, raw_payload, captured_at, source, status, parse_ok,
    saved_at, title, thumbnail, description, topic_tags, importance, tagged_at, author, media_type,
    user_id, collection_id, deadline_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(id) DO UPDATE SET
   status = excluded.status,
   saved_at = excluded.saved_at,
   description = excluded.description,
   topic_tags = excluded.topic_tags,
   importance = excluded.importance,
   tagged_at = excluded.tagged_at,
   author = excluded.author,
   media_type = excluded.media_type,
   user_id = excluded.user_id,
   collection_id = excluded.collection_id,
   deadline_at = excluded.deadline_at`;

// Collections sync rail. Identity columns (id, user_id, created_at) are write-once;
// on an id conflict only the mutable columns (name, is_default) are updated.
export const COLLECTIONS_UPSERT_SQL = `INSERT INTO collections
   (id, user_id, name, created_at, is_default)
 VALUES (?, ?, ?, ?, ?)
 ON CONFLICT(id) DO UPDATE SET
   name = excluded.name,
   is_default = excluded.is_default`;
