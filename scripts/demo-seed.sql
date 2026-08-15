-- FlarePulse demo data, for the local development database only.
--
-- Applied by `scripts/demo.mjs` through `wrangler d1 execute DB --local`, which
-- writes the SQLite file under `.wrangler/state`. It is never part of a
-- migration and never runs against the remote database: a deployed instance
-- starts with no monitors and no account, and `scripts/demo.mjs` is the only
-- thing that creates a credential.
--
-- Every timestamp is relative to `unixepoch()`, so a fresh run reads as "checked
-- just now" rather than as whenever the file was written.
--
-- Re-running replaces everything below. It leaves the schema and the
-- `d1_migrations` table alone.

DELETE FROM sessions;
DELETE FROM heartbeats;
DELETE FROM heartbeat_hourly;
DELETE FROM heartbeat_daily;
DELETE FROM incidents;
DELETE FROM maintenance_windows;
DELETE FROM notification_channels;
DELETE FROM monitors;
DELETE FROM monitor_groups;

-- So a second run produces the same ids as the first: the demo is meant to be
-- recorded more than once.
DELETE FROM sqlite_sequence
WHERE name IN (
  'monitor_groups', 'monitors', 'heartbeats',
  'incidents', 'maintenance_windows', 'notification_channels'
);

-- The heading the public page carries, and the two incident policies. Reset so a
-- second run is the same demo as the first; the Settings tab is where they are
-- meant to be changed on camera.
UPDATE settings
SET site_name = 'FlarePulse',
    auto_open_incidents = 1,
    auto_resolve_incidents = 1,
    updated_at = unixepoch()
WHERE id = 1;

-- Two public groups and one hidden one, so the status page and the admin panel
-- disagree about what exists — which is the point of the Public/Hidden switch.
INSERT INTO monitor_groups (id, name, position, is_public) VALUES
  (1, 'Core', 0, 1),
  (2, 'Edge', 1, 1),
  (3, 'Internal', 2, 0);

-- One of each type, one disabled, one never checked, one down.
INSERT INTO monitors
  (id, name, type, target, interval_seconds, timeout_ms, retries, expected_status,
   keyword, group_id, enabled, status, fail_streak, next_check_at, last_checked_at, created_at)
VALUES
  (1, 'api.example.com', 'http', 'https://api.example.com/health', 60, 10000, 2, 200,
   'ok', 1, 1, 'up', 0, unixepoch() + 40, unixepoch() - 20, unixepoch() - 2592000),
  (2, 'www.example.com', 'http', 'https://www.example.com/', 60, 10000, 2, NULL,
   NULL, 1, 1, 'up', 0, unixepoch() + 45, unixepoch() - 15, unixepoch() - 2592000),
  (3, 'db.example.com', 'tcp', 'db.example.com:5432', 60, 5000, 2, NULL,
   NULL, 1, 1, 'down', 12, unixepoch() + 30, unixepoch() - 30, unixepoch() - 1209600),
  (4, 'cdn.example.com', 'http', 'https://cdn.example.com/ping', 120, 10000, 1, 204,
   NULL, 2, 1, 'up', 0, unixepoch() + 90, unixepoch() - 30, unixepoch() - 604800),
  (5, 'dns.example.com', 'dns', 'example.com', 300, 5000, 2, NULL,
   NULL, 2, 1, 'pending', 0, 0, NULL, unixepoch() - 120),
  (6, 'legacy.example.com', 'http', 'https://legacy.example.com/', 300, 10000, 2, NULL,
   NULL, 2, 0, 'up', 0, 0, unixepoch() - 86400, unixepoch() - 7776000),
  (7, 'vault.internal', 'tcp', 'vault.internal:8200', 60, 5000, 2, NULL,
   NULL, 3, 1, 'up', 0, unixepoch() + 50, unixepoch() - 10, unixepoch() - 2592000);

-- 24h of per-minute checks for every monitor that has ever been checked: what
-- the 40-segment bar and the 24h chart read. The down monitor fails for the last
-- twelve minutes only, so its bar shows the failure starting rather than a solid
-- red block.
WITH RECURSIVE minute(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM minute WHERE i < 1439)
INSERT INTO heartbeats (monitor_id, checked_at, status, latency_ms, message)
SELECT
  m.id,
  (unixepoch() / 60) * 60 - minute.i * 60,
  CASE
    WHEN m.id = 3 AND minute.i < 12 THEN 'down'
    WHEN m.id = 4 AND minute.i BETWEEN 500 AND 521 THEN 'down'
    WHEN m.id = 2 AND minute.i BETWEEN 900 AND 903 THEN 'down'
    ELSE 'up'
  END,
  CASE
    WHEN m.id = 3 AND minute.i < 12 THEN NULL
    WHEN m.id = 4 AND minute.i BETWEEN 500 AND 521 THEN NULL
    WHEN m.id = 2 AND minute.i BETWEEN 900 AND 903 THEN NULL
    ELSE CASE m.id WHEN 1 THEN 38 WHEN 2 THEN 96 WHEN 3 THEN 14 WHEN 4 THEN 61 ELSE 22 END
      + (abs(random()) % 17)
      -- A gentle upward drift on one monitor, so a chart has a shape.
      + CASE WHEN m.id = 2 THEN (1440 - minute.i) / 36 ELSE 0 END
  END,
  CASE
    WHEN m.id = 3 AND minute.i < 12 THEN 'connect ECONNREFUSED'
    WHEN m.id = 4 AND minute.i BETWEEN 500 AND 521 THEN 'HTTP 503'
    WHEN m.id = 2 AND minute.i BETWEEN 900 AND 903 THEN 'HTTP 502'
    WHEN m.type = 'tcp' THEN 'connected'
    ELSE '200'
  END
FROM monitors m, minute
WHERE m.id IN (1, 2, 3, 4, 7);

-- 7 days of hourly buckets and 90 days of daily ones: the 7d/30d/90d windows
-- read these tables and nothing else, so without them those tabs are empty. The
-- three outages the raw heartbeats above contain are counted here too, or the
-- same monitor would read 99.7% over 24h and a flat 100% over 7 days.
WITH RECURSIVE hour(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM hour WHERE i < 167)
INSERT INTO heartbeat_hourly (monitor_id, bucket_start, up_count, down_count, latency_p50, latency_p95)
SELECT
  m.id,
  (unixepoch() / 3600) * 3600 - hour.i * 3600,
  CASE
    WHEN m.id = 3 AND hour.i = 0 THEN 48
    WHEN m.id = 4 AND hour.i = 8 THEN 38
    WHEN m.id = 2 AND hour.i = 15 THEN 56
    ELSE 60
  END,
  CASE
    WHEN m.id = 3 AND hour.i = 0 THEN 12
    WHEN m.id = 4 AND hour.i = 8 THEN 22
    WHEN m.id = 2 AND hour.i = 15 THEN 4
    ELSE 0
  END,
  CASE m.id WHEN 1 THEN 44 WHEN 2 THEN 108 WHEN 3 THEN 19 WHEN 4 THEN 68 ELSE 27 END
    + (abs(random()) % 9),
  CASE m.id WHEN 1 THEN 78 WHEN 2 THEN 190 WHEN 3 THEN 31 WHEN 4 THEN 121 ELSE 44 END
    + (abs(random()) % 21)
FROM monitors m, hour
WHERE m.id IN (1, 2, 3, 4, 7);

WITH RECURSIVE day(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM day WHERE i < 89)
INSERT INTO heartbeat_daily (monitor_id, bucket_start, up_count, down_count, latency_p50, latency_p95)
SELECT
  m.id,
  (unixepoch() / 86400) * 86400 - day.i * 86400,
  CASE
    WHEN m.id = 3 AND day.i = 0 THEN 1428
    WHEN m.id = 4 AND day.i = 0 THEN 1418
    WHEN m.id = 2 AND day.i = 0 THEN 1436
    WHEN m.id = 4 AND day.i IN (2, 31) THEN 1180
    WHEN m.id = 1 AND day.i = 47 THEN 1370
    ELSE 1440
  END,
  CASE
    WHEN m.id = 3 AND day.i = 0 THEN 12
    WHEN m.id = 4 AND day.i = 0 THEN 22
    WHEN m.id = 2 AND day.i = 0 THEN 4
    WHEN m.id = 4 AND day.i IN (2, 31) THEN 260
    WHEN m.id = 1 AND day.i = 47 THEN 70
    ELSE 0
  END,
  CASE m.id WHEN 1 THEN 45 WHEN 2 THEN 112 WHEN 3 THEN 20 WHEN 4 THEN 70 ELSE 28 END
    + (abs(random()) % 11),
  CASE m.id WHEN 1 THEN 84 WHEN 2 THEN 205 WHEN 3 THEN 33 WHEN 4 THEN 130 ELSE 47 END
    + (abs(random()) % 25)
FROM monitors m, day
WHERE m.id IN (1, 2, 3, 4, 7);

-- One machine-opened incident that is still open, two hand-written ones that are
-- closed: the timeline has both kinds and both states.
INSERT INTO incidents (monitor_id, title, body, status, started_at, resolved_at, auto) VALUES
  (3, 'db.example.com is down',
   'Opened automatically after 2 consecutive failed checks.',
   'investigating', unixepoch() - 660, NULL, 1),
  (4, 'Elevated 5xx from the edge cache',
   'A cache node returned 503 for about twenty minutes. Rotated out of the pool.',
   'resolved', unixepoch() - 30000, unixepoch() - 28200, 0),
  (NULL, 'Scheduled certificate rotation',
   'Certificates were rotated on all public endpoints. No downtime observed.',
   'resolved', unixepoch() - 190000, unixepoch() - 186400, 0);

-- One window in progress and one still ahead, so the banner has both to say.
INSERT INTO maintenance_windows (title, body, starts_at, ends_at) VALUES
  ('Database upgrade', 'Read-only for about ten minutes.', unixepoch() - 600, unixepoch() + 2400),
  ('Edge cache migration', 'No downtime expected.', unixepoch() + 172800, unixepoch() + 180000);

-- Unroutable endpoints and a placeholder token: nothing here can deliver, and
-- nothing is sent unless someone presses Send test message.
INSERT INTO notification_channels (type, name, url, bot_token, chat_id, enabled, last_sent_at, last_error) VALUES
  ('webhook', 'Ops webhook', 'https://webhook.invalid/flarepulse', NULL, NULL, 1, unixepoch() - 2640, NULL),
  ('discord', 'Discord #alerts', 'https://discord.invalid/api/webhooks/0/x', NULL, NULL, 1, NULL, 'HTTP 404'),
  ('telegram', 'On-call chat', NULL, '000000:PLACEHOLDER-LOCAL-ONLY', '-1000000000000', 0, NULL, NULL);
