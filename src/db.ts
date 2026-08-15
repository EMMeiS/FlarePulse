export type MonitorType = "http" | "tcp" | "dns";
export type CheckStatus = "up" | "down";
export type MonitorStatus = CheckStatus | "pending";

/** Unix seconds, the unit every timestamp column in the schema stores. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

export interface Monitor {
  id: number;
  name: string;
  type: MonitorType;
  target: string;
  interval_seconds: number;
  timeout_ms: number;
  retries: number;
  expected_status: number | null;
  keyword: string | null;
  keyword_invert: number;
  group_id: number | null;
  enabled: number;
  status: MonitorStatus;
  fail_streak: number;
  next_check_at: number;
  last_checked_at: number | null;
  created_at: number;
}

export interface NewMonitor {
  name: string;
  type: MonitorType;
  target: string;
  interval_seconds?: number;
  timeout_ms?: number;
  retries?: number;
  expected_status?: number | null;
  keyword?: string | null;
  keyword_invert?: boolean;
  group_id?: number | null;
  enabled?: boolean;
  next_check_at?: number;
}

export interface Heartbeat {
  id: number;
  monitor_id: number;
  checked_at: number;
  status: CheckStatus;
  latency_ms: number | null;
  message: string | null;
}

/**
 * What one completed check persists. `status` is the raw result of that single
 * check; `monitorStatus` and `failStreak` are the caller's decision, because
 * the "N failures before down" rule is checker logic, not storage logic.
 */
export interface CheckResult {
  monitorId: number;
  status: CheckStatus;
  latencyMs: number | null;
  message: string | null;
  checkedAt: number;
  monitorStatus: MonitorStatus;
  failStreak: number;
  nextCheckAt: number;
}

export async function createMonitor(db: D1Database, input: NewMonitor): Promise<Monitor> {
  const monitor = await db
    .prepare(
      `INSERT INTO monitors (name, type, target, interval_seconds, timeout_ms, retries,
                             expected_status, keyword, keyword_invert, group_id, enabled,
                             next_check_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(
      input.name,
      input.type,
      input.target,
      input.interval_seconds ?? 60,
      input.timeout_ms ?? 10_000,
      input.retries ?? 2,
      input.expected_status ?? null,
      input.keyword ?? null,
      input.keyword_invert ? 1 : 0,
      input.group_id ?? null,
      input.enabled === false ? 0 : 1,
      input.next_check_at ?? 0,
    )
    .first<Monitor>();

  if (!monitor) throw new Error("monitor insert returned no row");
  return monitor;
}

export async function listMonitors(db: D1Database): Promise<Monitor[]> {
  const { results } = await db.prepare("SELECT * FROM monitors ORDER BY id").all<Monitor>();
  return results;
}

export interface AdminMonitor extends Monitor {
  group_name: string | null;
}

/**
 * The admin list. Unlike `publicMonitors` this is the whole row — target and
 * schedule included — because an admin who cannot see a target cannot edit it.
 */
export async function adminMonitors(db: D1Database): Promise<AdminMonitor[]> {
  const { results } = await db
    .prepare(
      `SELECT m.*, g.name AS group_name
       FROM monitors m LEFT JOIN monitor_groups g ON g.id = m.group_id
       ORDER BY m.group_id IS NULL, g.position, g.id, m.id`,
    )
    .all<AdminMonitor>();
  return results;
}

export async function monitorById(db: D1Database, id: number): Promise<Monitor | null> {
  return await db.prepare("SELECT * FROM monitors WHERE id = ?").bind(id).first<Monitor>();
}

/**
 * The columns a PATCH may touch. `status`, `fail_streak` and `last_checked_at`
 * belong to the checker; `created_at` belongs to history.
 */
const MONITOR_PATCH_COLUMNS = [
  "name",
  "type",
  "target",
  "interval_seconds",
  "timeout_ms",
  "retries",
  "expected_status",
  "keyword",
  "keyword_invert",
  "group_id",
  "enabled",
  "next_check_at",
] as const;

export type PatchValue = string | number | null;
export type MonitorPatch = Partial<Record<(typeof MONITOR_PATCH_COLUMNS)[number], PatchValue>>;

/** Builds the SET list from an allowlist, so a column name can never come from a request. */
function assignments(columns: readonly string[]): string {
  return columns.map((column) => `${column} = ?`).join(", ");
}

export async function updateMonitor(
  db: D1Database,
  id: number,
  patch: MonitorPatch,
): Promise<Monitor | null> {
  const columns = MONITOR_PATCH_COLUMNS.filter((column) => patch[column] !== undefined);
  if (columns.length === 0) return await monitorById(db, id);

  return await db
    .prepare(`UPDATE monitors SET ${assignments(columns)} WHERE id = ? RETURNING *`)
    .bind(...columns.map((column) => patch[column] ?? null), id)
    .first<Monitor>();
}

export async function deleteMonitor(db: D1Database, id: number): Promise<boolean> {
  const row = await db
    .prepare("DELETE FROM monitors WHERE id = ? RETURNING id")
    .bind(id)
    .first<{ id: number }>();
  return row !== null;
}

export interface MonitorGroup {
  id: number;
  name: string;
  position: number;
  is_public: number;
}

export async function listGroups(db: D1Database): Promise<MonitorGroup[]> {
  const { results } = await db
    .prepare("SELECT * FROM monitor_groups ORDER BY position, id")
    .all<MonitorGroup>();
  return results;
}

export async function createGroup(
  db: D1Database,
  input: { name: string; position?: number; is_public?: boolean },
): Promise<MonitorGroup> {
  const group = await db
    .prepare(
      "INSERT INTO monitor_groups (name, position, is_public) VALUES (?, ?, ?) RETURNING *",
    )
    .bind(input.name, input.position ?? 0, input.is_public === false ? 0 : 1)
    .first<MonitorGroup>();

  if (!group) throw new Error("group insert returned no row");
  return group;
}

const GROUP_PATCH_COLUMNS = ["name", "position", "is_public"] as const;
export type GroupPatch = Partial<Record<(typeof GROUP_PATCH_COLUMNS)[number], PatchValue>>;

export async function updateGroup(
  db: D1Database,
  id: number,
  patch: GroupPatch,
): Promise<MonitorGroup | null> {
  const columns = GROUP_PATCH_COLUMNS.filter((column) => patch[column] !== undefined);
  if (columns.length === 0) {
    return await db
      .prepare("SELECT * FROM monitor_groups WHERE id = ?")
      .bind(id)
      .first<MonitorGroup>();
  }

  return await db
    .prepare(`UPDATE monitor_groups SET ${assignments(columns)} WHERE id = ? RETURNING *`)
    .bind(...columns.map((column) => patch[column] ?? null), id)
    .first<MonitorGroup>();
}

/** Monitors survive their group: `0001` makes `group_id` ON DELETE SET NULL. */
export async function deleteGroup(db: D1Database, id: number): Promise<boolean> {
  const row = await db
    .prepare("DELETE FROM monitor_groups WHERE id = ? RETURNING id")
    .bind(id)
    .first<{ id: number }>();
  return row !== null;
}

export interface DueMonitor extends Monitor {
  /** 1 unless the monitor sits in a group with `is_public = 0`. Ungrouped is public. */
  is_public: number;
}

/** The query the cron handler runs every minute. Backed by the monitors_due index. */
export async function dueMonitors(
  db: D1Database,
  now: number,
  limit = 50,
): Promise<DueMonitor[]> {
  const { results } = await db
    .prepare(
      `SELECT m.*, COALESCE(g.is_public, 1) AS is_public
       FROM monitors m LEFT JOIN monitor_groups g ON g.id = m.group_id
       WHERE m.enabled = 1 AND m.next_check_at <= ?
       ORDER BY m.next_check_at, m.id
       LIMIT ?`,
    )
    .bind(now, limit)
    .all<DueMonitor>();
  return results;
}

/**
 * One heartbeat row plus the monitor's new schedule, in a single batch — which
 * is one D1 subrequest rather than two, and matters against the free plan's
 * per-invocation limits.
 */
export async function recordCheck(db: D1Database, result: CheckResult): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO heartbeats (monitor_id, checked_at, status, latency_ms, message)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(result.monitorId, result.checkedAt, result.status, result.latencyMs, result.message),
    db
      .prepare(
        `UPDATE monitors
         SET status = ?, fail_streak = ?, next_check_at = ?, last_checked_at = ?
         WHERE id = ?`,
      )
      .bind(
        result.monitorStatus,
        result.failStreak,
        result.nextCheckAt,
        result.checkedAt,
        result.monitorId,
      ),
  ]);
}

export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved";

export interface Incident {
  id: number;
  monitor_id: number | null;
  title: string;
  body: string | null;
  status: IncidentStatus;
  started_at: number;
  resolved_at: number | null;
  /** 1 when the checker opened it, 0 when a human did. */
  auto: number;
}

export interface MaintenanceWindow {
  id: number;
  title: string;
  body: string | null;
  starts_at: number;
  ends_at: number;
}

/** A monitor as the public status page is allowed to see it — no target, no schedule. */
export interface PublicMonitorRow {
  id: number;
  name: string;
  type: MonitorType;
  status: MonitorStatus;
  last_checked_at: number | null;
  group_id: number | null;
  group_name: string | null;
}

export interface UptimeCount {
  monitor_id: number;
  up_count: number;
  down_count: number;
}

/** One heartbeat as the read paths need it: which monitor, when, what, how fast. */
export interface HeartbeatSample {
  monitor_id: number;
  checked_at: number;
  status: CheckStatus;
  latency_ms: number | null;
}

export interface BucketRow {
  monitor_id: number;
  bucket_start: number;
  up_count: number;
  down_count: number;
  latency_p50: number | null;
  latency_p95: number | null;
}

export type RollupTable = "heartbeat_hourly" | "heartbeat_daily";
export type UptimeSource = "heartbeats" | RollupTable;

const PUBLIC_MONITOR_COLUMNS = `m.id, m.name, m.type, m.status, m.last_checked_at,
                                m.group_id, g.name AS group_name`;

/**
 * Enabled monitors that are either ungrouped or in a public group. A disabled
 * monitor is not being checked, so publishing its last known status would be a
 * lie; a private group is the mechanism for hiding one that is.
 */
export async function publicMonitors(db: D1Database): Promise<PublicMonitorRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${PUBLIC_MONITOR_COLUMNS}
       FROM monitors m LEFT JOIN monitor_groups g ON g.id = m.group_id
       WHERE m.enabled = 1 AND (m.group_id IS NULL OR g.is_public = 1)
       ORDER BY m.group_id IS NULL, g.position, g.id, m.id`,
    )
    .all<PublicMonitorRow>();
  return results;
}

/** The same visibility rule for one monitor, for the per-monitor endpoints. */
export async function publicMonitor(
  db: D1Database,
  monitorId: number,
): Promise<PublicMonitorRow | null> {
  return await db
    .prepare(
      `SELECT ${PUBLIC_MONITOR_COLUMNS}
       FROM monitors m LEFT JOIN monitor_groups g ON g.id = m.group_id
       WHERE m.id = ? AND m.enabled = 1 AND (m.group_id IS NULL OR g.is_public = 1)`,
    )
    .bind(monitorId)
    .first<PublicMonitorRow>();
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** Up/down totals per monitor since a horizon, from raw heartbeats or a rollup table. */
export async function uptimeSince(
  db: D1Database,
  monitorIds: number[],
  since: number,
  source: UptimeSource,
): Promise<UptimeCount[]> {
  if (monitorIds.length === 0) return [];
  const sql =
    source === "heartbeats"
      ? `SELECT monitor_id,
                SUM(status = 'up') AS up_count,
                SUM(status = 'down') AS down_count
         FROM heartbeats
         WHERE monitor_id IN (${placeholders(monitorIds.length)}) AND checked_at >= ?
         GROUP BY monitor_id`
      : `SELECT monitor_id, SUM(up_count) AS up_count, SUM(down_count) AS down_count
         FROM ${source}
         WHERE monitor_id IN (${placeholders(monitorIds.length)}) AND bucket_start >= ?
         GROUP BY monitor_id`;
  const { results } = await db
    .prepare(sql)
    .bind(...monitorIds, since)
    .all<UptimeCount>();
  return results;
}

/**
 * The newest `limit` heartbeats for each monitor, oldest first, in one query —
 * the heartbeat bar for a whole page without a query per monitor.
 */
export async function heartbeatBars(
  db: D1Database,
  monitorIds: number[],
  limit: number,
): Promise<HeartbeatSample[]> {
  if (monitorIds.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT monitor_id, checked_at, status, latency_ms FROM (
         SELECT monitor_id, checked_at, status, latency_ms,
                ROW_NUMBER() OVER (PARTITION BY monitor_id ORDER BY checked_at DESC, id DESC) AS rn
         FROM heartbeats
         WHERE monitor_id IN (${placeholders(monitorIds.length)})
       )
       WHERE rn <= ?
       ORDER BY monitor_id, checked_at`,
    )
    .bind(...monitorIds, limit)
    .all<HeartbeatSample>();
  return results;
}

/**
 * Every raw heartbeat for one monitor since a horizon. Only the 24h window uses
 * this — 1,440 rows at a 60s interval, which is a cheap read and an exact
 * percentile. The longer windows read buckets that are already computed.
 */
export async function heartbeatsSince(
  db: D1Database,
  monitorId: number,
  since: number,
): Promise<HeartbeatSample[]> {
  const { results } = await db
    .prepare(
      `SELECT monitor_id, checked_at, status, latency_ms FROM heartbeats
       WHERE monitor_id = ? AND checked_at >= ?
       ORDER BY checked_at`,
    )
    .bind(monitorId, since)
    .all<HeartbeatSample>();
  return results;
}

/** Pre-computed chart buckets for the windows longer than a day. */
export async function rolledBuckets(
  db: D1Database,
  monitorId: number,
  since: number,
  table: RollupTable,
): Promise<BucketRow[]> {
  const { results } = await db
    .prepare(
      `SELECT monitor_id, bucket_start, up_count, down_count, latency_p50, latency_p95
       FROM ${table}
       WHERE monitor_id = ? AND bucket_start >= ?
       ORDER BY bucket_start`,
    )
    .bind(monitorId, since)
    .all<BucketRow>();
  return results;
}

/** Running and upcoming maintenance. Anything already finished is history. */
export async function activeMaintenance(
  db: D1Database,
  now: number,
  limit = 5,
): Promise<MaintenanceWindow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM maintenance_windows
       WHERE ends_at >= ?
       ORDER BY starts_at
       LIMIT ?`,
    )
    .bind(now, limit)
    .all<MaintenanceWindow>();
  return results;
}

export async function recentIncidents(db: D1Database, limit = 10): Promise<Incident[]> {
  const { results } = await db
    .prepare("SELECT * FROM incidents ORDER BY started_at DESC, id DESC LIMIT ?")
    .bind(limit)
    .all<Incident>();
  return results;
}

export interface NewIncident {
  monitor_id?: number | null;
  title: string;
  body?: string | null;
  status?: IncidentStatus;
  started_at?: number;
  resolved_at?: number | null;
  auto?: number;
}

export async function createIncident(
  db: D1Database,
  input: NewIncident,
  now: number,
): Promise<Incident> {
  const incident = await db
    .prepare(
      `INSERT INTO incidents (monitor_id, title, body, status, started_at, resolved_at, auto)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(
      input.monitor_id ?? null,
      input.title,
      input.body ?? null,
      input.status ?? "investigating",
      input.started_at ?? now,
      input.resolved_at ?? null,
      input.auto ?? 0,
    )
    .first<Incident>();

  if (!incident) throw new Error("incident insert returned no row");
  return incident;
}

/**
 * The recovery lookup: the still-open incident this monitor's own down
 * transition opened. `auto = 1` is the whole point — a hand-written incident is
 * never closed by a cron tick. Open means both columns agree it is open; the
 * admin API derives one from the other, and this read does not have to trust it.
 */
export async function openAutoIncidentFor(
  db: D1Database,
  monitorId: number,
): Promise<Incident | null> {
  return await db
    .prepare(
      `SELECT * FROM incidents
       WHERE monitor_id = ? AND auto = 1 AND resolved_at IS NULL AND status != 'resolved'
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(monitorId)
    .first<Incident>();
}

/** Resolves and appends, so the timeline keeps the failure that opened it. */
export async function resolveIncident(
  db: D1Database,
  id: number,
  note: string,
  now: number,
): Promise<Incident | null> {
  return await db
    .prepare(
      `UPDATE incidents
       SET status = 'resolved',
           resolved_at = ?,
           body = CASE WHEN body IS NULL OR body = '' THEN ? ELSE body || ? END
       WHERE id = ?
       RETURNING *`,
    )
    .bind(now, note, `\n\n${note}`, id)
    .first<Incident>();
}

const INCIDENT_PATCH_COLUMNS = [
  "monitor_id",
  "title",
  "body",
  "status",
  "started_at",
  "resolved_at",
] as const;
export type IncidentPatch = Partial<
  Record<(typeof INCIDENT_PATCH_COLUMNS)[number], PatchValue>
>;

export async function updateIncident(
  db: D1Database,
  id: number,
  patch: IncidentPatch,
): Promise<Incident | null> {
  const columns = INCIDENT_PATCH_COLUMNS.filter((column) => patch[column] !== undefined);
  if (columns.length === 0) {
    return await db.prepare("SELECT * FROM incidents WHERE id = ?").bind(id).first<Incident>();
  }

  return await db
    .prepare(`UPDATE incidents SET ${assignments(columns)} WHERE id = ? RETURNING *`)
    .bind(...columns.map((column) => patch[column] ?? null), id)
    .first<Incident>();
}

export async function deleteIncident(db: D1Database, id: number): Promise<boolean> {
  const row = await db
    .prepare("DELETE FROM incidents WHERE id = ? RETURNING id")
    .bind(id)
    .first<{ id: number }>();
  return row !== null;
}

/** Every window, past included — the admin schedules history, the visitor reads now. */
export async function listMaintenance(db: D1Database): Promise<MaintenanceWindow[]> {
  const { results } = await db
    .prepare("SELECT * FROM maintenance_windows ORDER BY starts_at DESC")
    .all<MaintenanceWindow>();
  return results;
}

export async function maintenanceById(
  db: D1Database,
  id: number,
): Promise<MaintenanceWindow | null> {
  return await db
    .prepare("SELECT * FROM maintenance_windows WHERE id = ?")
    .bind(id)
    .first<MaintenanceWindow>();
}

export async function createMaintenance(
  db: D1Database,
  input: { title: string; body?: string | null; starts_at: number; ends_at: number },
): Promise<MaintenanceWindow> {
  const window = await db
    .prepare(
      `INSERT INTO maintenance_windows (title, body, starts_at, ends_at)
       VALUES (?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(input.title, input.body ?? null, input.starts_at, input.ends_at)
    .first<MaintenanceWindow>();

  if (!window) throw new Error("maintenance insert returned no row");
  return window;
}

const MAINTENANCE_PATCH_COLUMNS = ["title", "body", "starts_at", "ends_at"] as const;
export type MaintenancePatch = Partial<
  Record<(typeof MAINTENANCE_PATCH_COLUMNS)[number], PatchValue>
>;

export async function updateMaintenance(
  db: D1Database,
  id: number,
  patch: MaintenancePatch,
): Promise<MaintenanceWindow | null> {
  const columns = MAINTENANCE_PATCH_COLUMNS.filter((column) => patch[column] !== undefined);
  if (columns.length === 0) return await maintenanceById(db, id);

  return await db
    .prepare(`UPDATE maintenance_windows SET ${assignments(columns)} WHERE id = ? RETURNING *`)
    .bind(...columns.map((column) => patch[column] ?? null), id)
    .first<MaintenanceWindow>();
}

export async function deleteMaintenance(db: D1Database, id: number): Promise<boolean> {
  const row = await db
    .prepare("DELETE FROM maintenance_windows WHERE id = ? RETURNING id")
    .bind(id)
    .first<{ id: number }>();
  return row !== null;
}

export interface Admin {
  id: number;
  username: string;
  password_hash: string;
  failed_attempts: number;
  locked_until: number | null;
  created_at: number;
}

export interface Settings {
  id: number;
  site_name: string;
  /** Global policy: whether the checker opens and closes incidents itself. */
  auto_open_incidents: number;
  auto_resolve_incidents: number;
  updated_at: number | null;
}

export async function adminExists(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS one FROM admins WHERE id = 1").first<{ one: number }>();
  return row !== null;
}

/** The id is pinned to 1: a second admin fails on the primary key, by design. */
export async function createAdmin(
  db: D1Database,
  username: string,
  passwordHash: string,
  now: number,
): Promise<Admin> {
  const admin = await db
    .prepare(
      `INSERT INTO admins (id, username, password_hash, created_at)
       VALUES (1, ?, ?, ?)
       RETURNING *`,
    )
    .bind(username, passwordHash, now)
    .first<Admin>();

  if (!admin) throw new Error("admin insert returned no row");
  return admin;
}

export async function getAdmin(db: D1Database, username: string): Promise<Admin | null> {
  return await db.prepare("SELECT * FROM admins WHERE username = ?").bind(username).first<Admin>();
}

export async function setAdminLock(
  db: D1Database,
  failedAttempts: number,
  lockedUntil: number | null,
): Promise<void> {
  await db
    .prepare("UPDATE admins SET failed_attempts = ?, locked_until = ? WHERE id = 1")
    .bind(failedAttempts, lockedUntil)
    .run();
}

export async function setAdminPassword(
  db: D1Database,
  username: string,
  passwordHash: string,
): Promise<void> {
  await db
    .prepare("UPDATE admins SET username = ?, password_hash = ? WHERE id = 1")
    .bind(username, passwordHash)
    .run();
}

export async function createSession(
  db: D1Database,
  id: string,
  adminId: number,
  now: number,
  ttl = 7 * 86_400,
): Promise<void> {
  await db
    .prepare("INSERT INTO sessions (id, admin_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(id, adminId, now, now + ttl)
    .run();
}

/** The session lookup on every admin request: one indexed read, no decisions. */
export async function sessionAdmin(
  db: D1Database,
  id: string,
  now: number,
): Promise<Admin | null> {
  return await db
    .prepare(
      `SELECT a.* FROM sessions s JOIN admins a ON a.id = s.admin_id
       WHERE s.id = ? AND s.expires_at > ?`,
    )
    .bind(id, now)
    .first<Admin>();
}

export async function deleteSession(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
}

export async function deleteSessionsFor(db: D1Database, adminId: number): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE admin_id = ?").bind(adminId).run();
}

export async function deleteExpiredSessions(db: D1Database, now: number): Promise<number> {
  const { meta } = await db
    .prepare("DELETE FROM sessions WHERE expires_at <= ?")
    .bind(now)
    .run();
  return meta.changes ?? 0;
}

export async function getSettings(db: D1Database): Promise<Settings> {
  const settings = await db.prepare("SELECT * FROM settings WHERE id = 1").first<Settings>();
  if (!settings) throw new Error("settings row missing — migration 0003 seeds it");
  return settings;
}

const SETTINGS_PATCH_COLUMNS = [
  "site_name",
  "auto_open_incidents",
  "auto_resolve_incidents",
] as const;
export type SettingsPatch = Partial<Record<(typeof SETTINGS_PATCH_COLUMNS)[number], PatchValue>>;

/** One statement for the branding form and the notification toggles alike. */
export async function updateSettings(
  db: D1Database,
  patch: SettingsPatch,
  now: number,
): Promise<Settings> {
  const columns = SETTINGS_PATCH_COLUMNS.filter((column) => patch[column] !== undefined);

  const settings = await db
    .prepare(
      `UPDATE settings SET ${assignments([...columns, "updated_at"])} WHERE id = 1 RETURNING *`,
    )
    .bind(...columns.map((column) => patch[column] ?? null), now)
    .first<Settings>();

  if (!settings) throw new Error("settings update returned no row");
  return settings;
}

export type ChannelType = "webhook" | "discord" | "telegram";

export interface NotificationChannel {
  id: number;
  type: ChannelType;
  name: string;
  /** webhook and discord only. */
  url: string | null;
  /** telegram only, and a credential: never in the public payload. */
  bot_token: string | null;
  chat_id: string | null;
  enabled: number;
  last_sent_at: number | null;
  last_error: string | null;
  created_at: number;
}

export interface NewChannel {
  type: ChannelType;
  name: string;
  url?: string | null;
  bot_token?: string | null;
  chat_id?: string | null;
  enabled?: boolean;
}

export async function listChannels(db: D1Database): Promise<NotificationChannel[]> {
  const { results } = await db
    .prepare("SELECT * FROM notification_channels ORDER BY id")
    .all<NotificationChannel>();
  return results;
}

/** The dispatch list: one request per row in here, per tick. */
export async function enabledChannels(db: D1Database): Promise<NotificationChannel[]> {
  const { results } = await db
    .prepare("SELECT * FROM notification_channels WHERE enabled = 1 ORDER BY id")
    .all<NotificationChannel>();
  return results;
}

export async function channelById(
  db: D1Database,
  id: number,
): Promise<NotificationChannel | null> {
  return await db
    .prepare("SELECT * FROM notification_channels WHERE id = ?")
    .bind(id)
    .first<NotificationChannel>();
}

export async function createChannel(
  db: D1Database,
  input: NewChannel,
): Promise<NotificationChannel> {
  const channel = await db
    .prepare(
      `INSERT INTO notification_channels (type, name, url, bot_token, chat_id, enabled)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(
      input.type,
      input.name,
      input.url ?? null,
      input.bot_token ?? null,
      input.chat_id ?? null,
      input.enabled === false ? 0 : 1,
    )
    .first<NotificationChannel>();

  if (!channel) throw new Error("channel insert returned no row");
  return channel;
}

const CHANNEL_PATCH_COLUMNS = [
  "type",
  "name",
  "url",
  "bot_token",
  "chat_id",
  "enabled",
] as const;
export type ChannelPatch = Partial<Record<(typeof CHANNEL_PATCH_COLUMNS)[number], PatchValue>>;

export async function updateChannel(
  db: D1Database,
  id: number,
  patch: ChannelPatch,
): Promise<NotificationChannel | null> {
  const columns = CHANNEL_PATCH_COLUMNS.filter((column) => patch[column] !== undefined);
  if (columns.length === 0) return await channelById(db, id);

  return await db
    .prepare(`UPDATE notification_channels SET ${assignments(columns)} WHERE id = ? RETURNING *`)
    .bind(...columns.map((column) => patch[column] ?? null), id)
    .first<NotificationChannel>();
}

export async function deleteChannel(db: D1Database, id: number): Promise<boolean> {
  const row = await db
    .prepare("DELETE FROM notification_channels WHERE id = ? RETURNING id")
    .bind(id)
    .first<{ id: number }>();
  return row !== null;
}

/** The whole delivery record: what happened last, and nothing before that. */
export async function markChannelDelivery(
  db: D1Database,
  id: number,
  now: number,
  error: string | null,
): Promise<void> {
  await db
    .prepare("UPDATE notification_channels SET last_sent_at = ?, last_error = ? WHERE id = ?")
    .bind(now, error, id)
    .run();
}

export async function recentHeartbeats(
  db: D1Database,
  monitorId: number,
  limit = 50,
): Promise<Heartbeat[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM heartbeats
       WHERE monitor_id = ?
       ORDER BY checked_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(monitorId, limit)
    .all<Heartbeat>();
  return results;
}
