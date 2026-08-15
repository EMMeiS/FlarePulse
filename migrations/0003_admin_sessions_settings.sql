-- The admin account, its sessions, and the settings it owns.
-- Notification channels and the auto-incident toggles arrive in 0004, with the
-- code that reads them.

-- One admin per instance, enforced by the schema rather than by a handler
-- that a second code path could forget to check. Multi-user is not a v1 feature
-- and a `role` column would be the invitation to build it.
CREATE TABLE admins (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL UNIQUE,
  -- 'pbkdf2-sha256$<iterations>$<salt-b64>$<hash-b64>'. The parameters live in
  -- the string so raising the iteration count cannot orphan an existing hash.
  password_hash TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE sessions (
  -- The SHA-256 of the cookie value, never the cookie value: a database dump
  -- must not hand over live sessions.
  id TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- The hourly pass prunes by this.
CREATE INDEX sessions_expiry ON sessions (expires_at);

-- One row, seeded here so every read finds it and no path needs an upsert.
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  site_name TEXT NOT NULL DEFAULT 'Levix',
  updated_at INTEGER
);

INSERT INTO settings (id) VALUES (1);
