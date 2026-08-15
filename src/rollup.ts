import type { HeartbeatSample } from "./db";

const HOUR = 3_600;
const DAY = 86_400;

/** Retention: raw heartbeats 7 days, hourly 90 days, daily 2 years. */
const RETENTION = { raw: 7 * DAY, hourly: 90 * DAY, daily: 730 * DAY };

/**
 * How far back the hourly pass looks. It runs every hour, so this is purely
 * slack for missed ticks — six hours of downtime can be made up, more than that
 * leaves a hole in the hourly history rather than reading a week of raw rows
 * every hour.
 */
const LOOKBACK_HOURS = 6;

export interface Bucket {
  monitorId: number;
  bucketStart: number;
  up: number;
  down: number;
  latencies: number[];
}

/** Nearest-rank percentile. D1's SQLite has no percentile function. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[index] ?? 0);
}

/**
 * Group raw heartbeats into fixed buckets. Shared with the status page's 24h
 * chart, so a bucket means the same thing whether it was computed on the way in
 * or on the way out.
 */
export function bucketHeartbeats(rows: HeartbeatSample[], bucketSize: number): Bucket[] {
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    const bucketStart = Math.floor(row.checked_at / bucketSize) * bucketSize;
    const key = `${row.monitor_id}:${bucketStart}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { monitorId: row.monitor_id, bucketStart, up: 0, down: 0, latencies: [] };
      buckets.set(key, bucket);
    }
    if (row.status === "up") bucket.up += 1;
    else bucket.down += 1;
    if (row.latency_ms !== null) bucket.latencies.push(row.latency_ms);
  }
  return [...buckets.values()].sort((a, b) => a.bucketStart - b.bucketStart);
}

async function rollupRange(
  db: D1Database,
  table: "heartbeat_hourly" | "heartbeat_daily",
  bucketSize: number,
  from: number,
  to: number,
): Promise<void> {
  const { results } = await db
    .prepare(
      `SELECT monitor_id, checked_at, status, latency_ms FROM heartbeats
       WHERE checked_at >= ? AND checked_at < ?`,
    )
    .bind(from, to)
    .all<HeartbeatSample>();
  if (results.length === 0) return;

  await db.batch(
    bucketHeartbeats(results, bucketSize).map((bucket) => {
      const sorted = bucket.latencies.sort((a, b) => a - b);
      return db
        .prepare(
          `INSERT INTO ${table} (monitor_id, bucket_start, up_count, down_count, latency_p50, latency_p95)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (monitor_id, bucket_start) DO UPDATE SET
             up_count = excluded.up_count,
             down_count = excluded.down_count,
             latency_p50 = excluded.latency_p50,
             latency_p95 = excluded.latency_p95`,
        )
        .bind(
          bucket.monitorId,
          bucket.bucketStart,
          bucket.up,
          bucket.down,
          percentile(sorted, 50),
          percentile(sorted, 95),
        );
    }),
  );
}

/**
 * The pass that keeps `heartbeats` from growing forever. Idempotent: every write
 * is an upsert and every delete is horizon-based, so a repeated or retried run
 * changes nothing.
 */
export async function rollupAndPrune(db: D1Database, now: number): Promise<void> {
  const hourStart = Math.floor(now / HOUR) * HOUR;
  await rollupRange(db, "heartbeat_hourly", HOUR, hourStart - LOOKBACK_HOURS * HOUR, hourStart);

  // Daily buckets come from raw heartbeats, not from the hourly rows, so the
  // daily p95 is a real p95 rather than an average of averages. That only works
  // because raw rows outlive by days the day they describe.
  if (hourStart % DAY === 0) {
    await rollupRange(db, "heartbeat_daily", DAY, hourStart - DAY, hourStart);
  }

  await db.batch([
    db.prepare("DELETE FROM heartbeats WHERE checked_at < ?").bind(now - RETENTION.raw),
    db.prepare("DELETE FROM heartbeat_hourly WHERE bucket_start < ?").bind(now - RETENTION.hourly),
    db.prepare("DELETE FROM heartbeat_daily WHERE bucket_start < ?").bind(now - RETENTION.daily),
  ]);
}
