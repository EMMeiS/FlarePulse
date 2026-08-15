import type {
  CheckStatus,
  Incident,
  MaintenanceWindow,
  MonitorStatus,
  MonitorType,
  PublicMonitorRow,
  UptimeSource,
} from "./db";
import {
  activeMaintenance,
  getSettings,
  heartbeatBars,
  heartbeatsSince,
  publicMonitor,
  publicMonitors,
  recentIncidents,
  rolledBuckets,
  uptimeSince,
} from "./db";
import { bucketHeartbeats, percentile } from "./rollup";

const HOUR = 3_600;
const DAY = 86_400;

export type StatusWindow = "24h" | "7d" | "30d" | "90d";

/**
 * A page-level word, not a fourth monitor status: `partial` is "some systems
 * down", which a visitor needs to be able to see at a glance.
 */
export type OverallStatus = "up" | "down" | "partial" | "pending";

export interface ResolvedWindow {
  window: StatusWindow;
  source: UptimeSource;
  bucketSize: number;
  span: number;
}

/**
 * Each window reads exactly one table. Mixing raw and rolled data inside one
 * series would give a chart whose left half means something different from its
 * right half; stopping at the last closed bucket is the honest alternative.
 */
const WINDOWS: Record<StatusWindow, ResolvedWindow> = {
  "24h": { window: "24h", source: "heartbeats", bucketSize: HOUR, span: DAY },
  "7d": { window: "7d", source: "heartbeat_hourly", bucketSize: HOUR, span: 7 * DAY },
  "30d": { window: "30d", source: "heartbeat_daily", bucketSize: DAY, span: 30 * DAY },
  "90d": { window: "90d", source: "heartbeat_daily", bucketSize: DAY, span: 90 * DAY },
};

/** Unknown input resolves to 24h — a status page should render, not 400. */
export function windowSource(window: string | null | undefined): ResolvedWindow {
  return WINDOWS[window as StatusWindow] ?? WINDOWS["24h"];
}

export function overallStatus(statuses: MonitorStatus[]): OverallStatus {
  const up = statuses.filter((status) => status === "up").length;
  const down = statuses.filter((status) => status === "down").length;
  if (up > 0 && down > 0) return "partial";
  if (down > 0) return "down";
  if (up > 0) return "up";
  return "pending";
}

/** Two decimals, because 99.97% and 100% are different promises. */
export function uptimePercent(up: number, down: number): number | null {
  const total = up + down;
  if (total === 0) return null;
  return Math.round((up / total) * 10_000) / 100;
}

export interface SeriesPoint {
  start: number;
  up: number;
  down: number;
  uptime: number | null;
  latency_p50: number | null;
  latency_p95: number | null;
}

export interface MonitorHistory {
  monitor: Pick<PublicMonitorRow, "id" | "name" | "type" | "status" | "last_checked_at">;
  window: StatusWindow;
  bucket_size: number;
  uptime: number | null;
  points: SeriesPoint[];
}

/**
 * One monitor's chart series. Null when the monitor is not publicly visible,
 * which the route turns into the same 404 an unknown id gets.
 */
export async function monitorHistory(
  db: D1Database,
  monitorId: number,
  now: number,
  window: string | null | undefined,
): Promise<MonitorHistory | null> {
  const monitor = await publicMonitor(db, monitorId);
  if (!monitor) return null;

  const resolved = windowSource(window);
  const since = now - resolved.span;
  const points =
    resolved.source === "heartbeats"
      ? bucketHeartbeats(await heartbeatsSince(db, monitorId, since), resolved.bucketSize).map(
          (bucket) => {
            const sorted = bucket.latencies.sort((a, b) => a - b);
            return {
              start: bucket.bucketStart,
              up: bucket.up,
              down: bucket.down,
              uptime: uptimePercent(bucket.up, bucket.down),
              latency_p50: percentile(sorted, 50),
              latency_p95: percentile(sorted, 95),
            };
          },
        )
      : (await rolledBuckets(db, monitorId, since, resolved.source)).map((bucket) => ({
          start: bucket.bucket_start,
          up: bucket.up_count,
          down: bucket.down_count,
          uptime: uptimePercent(bucket.up_count, bucket.down_count),
          latency_p50: bucket.latency_p50,
          latency_p95: bucket.latency_p95,
        }));

  // The window total comes from the points rather than a second query — same
  // rows, same source, one less round trip.
  const up = points.reduce((total, point) => total + point.up, 0);
  const down = points.reduce((total, point) => total + point.down, 0);

  return {
    monitor: {
      id: monitor.id,
      name: monitor.name,
      type: monitor.type,
      status: monitor.status,
      last_checked_at: monitor.last_checked_at,
    },
    window: resolved.window,
    bucket_size: resolved.bucketSize,
    uptime: uptimePercent(up, down),
    points,
  };
}
export interface BadgeData {
  label: string;
  value: string;
  status: MonitorStatus;
}

/**
 * What the badge says: the monitor's name, its 24h uptime and its current
 * status. Null when the monitor is not public — the same 404 an unknown id gets.
 */
export async function monitorBadge(
  db: D1Database,
  monitorId: number,
  now: number,
): Promise<BadgeData | null> {
  const monitor = await publicMonitor(db, monitorId);
  if (!monitor) return null;

  const [count] = await uptimeSince(db, [monitor.id], now - DAY, "heartbeats");
  const uptime = count ? uptimePercent(count.up_count, count.down_count) : null;
  return {
    label: monitor.name,
    // A monitor with no heartbeats yet says so; 100% would be a claim we cannot make.
    value: uptime === null ? "no data" : `${uptime}%`,
    status: monitor.status,
  };
}

export interface StatusHeartbeat {
  checked_at: number;
  status: CheckStatus;
  latency_ms: number | null;
}

export interface StatusMonitor {
  id: number;
  name: string;
  type: MonitorType;
  status: MonitorStatus;
  last_checked_at: number | null;
  latency_ms: number | null;
  uptime: number | null;
  heartbeats: StatusHeartbeat[];
}

export interface StatusGroup {
  id: number | null;
  name: string;
  monitors: StatusMonitor[];
}

export interface StatusPayload {
  name: string;
  generated_at: number;
  window: StatusWindow;
  overall: OverallStatus;
  monitors_up: number;
  monitors_total: number;
  groups: StatusGroup[];
  maintenance: MaintenanceWindow[];
  incidents: Incident[];
}

/** How many checks the heartbeat bar shows. Wide enough to read, small enough to send. */
export const BAR_LIMIT = 40;

/** What ungrouped monitors are called on the page; the admin panel is where they get grouped. */
const UNGROUPED = "Services";

/**
 * The whole public page in six queries in two waves, all of them flat in the
 * monitor count. A query per monitor would be 21 at twenty monitors and would run
 * out of CPU before it ran out of subrequests.
 */
export async function statusPayload(
  db: D1Database,
  now: number,
  window: string | null | undefined,
): Promise<StatusPayload> {
  const resolved = windowSource(window);
  const monitors = await publicMonitors(db);
  const ids = monitors.map((monitor) => monitor.id);

  const [counts, bars, maintenance, incidents, settings] = await Promise.all([
    uptimeSince(db, ids, now - resolved.span, resolved.source),
    heartbeatBars(db, ids, BAR_LIMIT),
    activeMaintenance(db, now),
    recentIncidents(db),
    getSettings(db),
  ]);

  const countById = new Map(counts.map((count) => [count.monitor_id, count]));
  const barsById = new Map<number, StatusHeartbeat[]>();
  for (const bar of bars) {
    const list = barsById.get(bar.monitor_id) ?? [];
    list.push({ checked_at: bar.checked_at, status: bar.status, latency_ms: bar.latency_ms });
    barsById.set(bar.monitor_id, list);
  }

  const groups: StatusGroup[] = [];
  for (const monitor of monitors) {
    const count = countById.get(monitor.id);
    const heartbeats = barsById.get(monitor.id) ?? [];
    const entry: StatusMonitor = {
      id: monitor.id,
      name: monitor.name,
      type: monitor.type,
      status: monitor.status,
      last_checked_at: monitor.last_checked_at,
      latency_ms: heartbeats.at(-1)?.latency_ms ?? null,
      uptime: count ? uptimePercent(count.up_count, count.down_count) : null,
      heartbeats,
    };

    const last = groups.at(-1);
    if (last && last.id === monitor.group_id) last.monitors.push(entry);
    else
      groups.push({
        id: monitor.group_id,
        name: monitor.group_name ?? UNGROUPED,
        monitors: [entry],
      });
  }

  return {
    name: settings.site_name,
    generated_at: now,
    window: resolved.window,
    overall: overallStatus(monitors.map((monitor) => monitor.status)),
    monitors_up: monitors.filter((monitor) => monitor.status === "up").length,
    monitors_total: monitors.length,
    groups,
    maintenance,
    incidents,
  };
}
