-- Queryable index of pairing rooms.
--
-- Rooms themselves are Durable Objects addressed by idFromName(code), and a
-- Durable Object's storage is private to that one instance, so there is no way
-- to enumerate them. This table is the index the admin dashboard reads.

CREATE TABLE IF NOT EXISTS rooms (
  code         TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  participants INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  ended_at     INTEGER
);

CREATE INDEX IF NOT EXISTS rooms_expires_at ON rooms (expires_at);
