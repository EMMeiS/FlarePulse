-- Monitors, groups, heartbeats and the two rollup tables.
-- Incidents, notification channels, maintenance windows, status page config and
-- admin users arrive in later migrations, when the screens that need them exist.

CREATE TABLE monitor_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  -- Groups are individually public or private on the status page.
  is_public INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0, 1))
);

CREATE TABLE monitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('http', 'tcp', 'dns')),
  target TEXT NOT NULL,
  -- 60s is the cron floor. Enforced here so no UI or API path can bypass it.
  interval_seconds INTEGER NOT NULL DEFAULT 60 CHECK (interval_seconds >= 60),
  timeout_ms INTEGER NOT NULL DEFAULT 10000 CHECK (timeout_ms > 0),
  -- Consecutive failures required before the monitor flips to 'down'.
  retries INTEGER NOT NULL DEFAULT 2 CHECK (retries >= 0),
  expected_status INTEGER,
  keyword TEXT,
  keyword_invert INTEGER NOT NULL DEFAULT 0 CHECK (keyword_invert IN (0, 1)),
  group_id INTEGER REFERENCES monitor_groups (id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('up', 'down', 'pending')),
  fail_streak INTEGER NOT NULL DEFAULT 0,
  -- Unix seconds. 0 means "due on the next cron tick".
  next_check_at INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- The query the cron handler runs every single minute.
CREATE INDEX monitors_due ON monitors (enabled, next_check_at);

CREATE TABLE heartbeats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  checked_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('up', 'down')),
  latency_ms INTEGER,
  message TEXT
);

-- Powers the heartbeat bar: newest N for one monitor.
CREATE INDEX heartbeats_monitor_time ON heartbeats (monitor_id, checked_at DESC);

-- Retention: raw heartbeats 7 days, hourly 90 days, daily 2 years.
-- Both rollup tables are written by the hourly rollup pass; they are
-- created now because the retention plan is already settled.
CREATE TABLE heartbeat_hourly (
  monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  bucket_start INTEGER NOT NULL,
  up_count INTEGER NOT NULL DEFAULT 0,
  down_count INTEGER NOT NULL DEFAULT 0,
  latency_p50 INTEGER,
  latency_p95 INTEGER,
  PRIMARY KEY (monitor_id, bucket_start)
);

CREATE TABLE heartbeat_daily (
  monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  bucket_start INTEGER NOT NULL,
  up_count INTEGER NOT NULL DEFAULT 0,
  down_count INTEGER NOT NULL DEFAULT 0,
  latency_p50 INTEGER,
  latency_p95 INTEGER,
  PRIMARY KEY (monitor_id, bucket_start)
);
