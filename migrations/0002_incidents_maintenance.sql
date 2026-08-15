-- The two tables the public status page renders.
-- Admin CRUD for both comes later, as does the checker opening incidents
-- automatically, which is when a column distinguishing manual from
-- automatic rows will actually be needed.

CREATE TABLE incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Optional: an incident can be about the platform rather than one monitor.
  monitor_id INTEGER REFERENCES monitors (id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'investigating'
    CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at INTEGER
);

-- The timeline query: newest first.
CREATE INDEX incidents_recent ON incidents (started_at DESC);

CREATE TABLE maintenance_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL
);

-- The banner query: anything that has not finished yet.
CREATE INDEX maintenance_upcoming ON maintenance_windows (ends_at);
