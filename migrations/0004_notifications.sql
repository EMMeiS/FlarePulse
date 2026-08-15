-- Notification channels, the two global incident toggles, and
-- the column that tells a machine-opened incident from a hand-written one.

-- Three types, one table. Which credential columns a row must carry is a schema
-- fact rather than a rule a handler could forget: webhook and discord are a URL
-- someone pasted, telegram is a bot token plus a chat id. `bot_token` is a
-- credential — it is never in the public payload and only the Worker reads it.
CREATE TABLE notification_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('webhook', 'discord', 'telegram')),
  name TEXT NOT NULL,
  url TEXT,
  bot_token TEXT,
  chat_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  -- The last delivery, kept on the row instead of in a log table: a table would
  -- spend D1 writes on history no screen reads, and this is what the panel shows.
  last_sent_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (
    (type IN ('webhook', 'discord') AND url IS NOT NULL AND bot_token IS NULL AND chat_id IS NULL)
    OR (type = 'telegram' AND bot_token IS NOT NULL AND chat_id IS NOT NULL AND url IS NULL)
  )
);

-- Whether incidents open and close by themselves is policy for the whole status
-- page, not per monitor. Both default to on: that is the behaviour an install
-- wants out of the box, so one that never opens the settings screen still gets it.
ALTER TABLE settings ADD COLUMN auto_open_incidents INTEGER NOT NULL DEFAULT 1
  CHECK (auto_open_incidents IN (0, 1));
ALTER TABLE settings ADD COLUMN auto_resolve_incidents INTEGER NOT NULL DEFAULT 1
  CHECK (auto_resolve_incidents IN (0, 1));

-- The column migration 0002 predicted. Auto-resolve only ever touches rows with
-- auto = 1: a human-written incident is never closed by a machine.
ALTER TABLE incidents ADD COLUMN auto INTEGER NOT NULL DEFAULT 0
  CHECK (auto IN (0, 1));

-- The recovery lookup: the open automatic incident for one monitor.
CREATE INDEX incidents_auto_open ON incidents (monitor_id, auto, resolved_at);
