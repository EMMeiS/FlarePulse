import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMonitor } from "../src/db";
import { rollupAndPrune } from "../src/rollup";

const HOUR = 3_600;
const DAY = 86_400;
// Hour-aligned and day-aligned instants, so the bucket maths in the tests is
// arithmetic rather than a second implementation of the code under test.
const HOUR_START = 1_699_999_200;
const DAY_START = 1_699_920_000;

interface RollupRow {
  monitor_id: number;
  bucket_start: number;
  up_count: number;
  down_count: number;
  latency_p50: number | null;
  latency_p95: number | null;
}

async function newMonitor(name: string) {
  const monitor = await createMonitor(env.DB, {
    name,
    type: "http",
    target: `https://${name}.test/`,
  });
  return monitor.id;
}

async function seedHeartbeats(
  monitorId: number,
  rows: [checkedAt: number, status: "up" | "down", latencyMs: number | null][],
) {
  await env.DB.batch(
    rows.map(([checkedAt, status, latencyMs]) =>
      env.DB.prepare(
        "INSERT INTO heartbeats (monitor_id, checked_at, status, latency_ms) VALUES (?, ?, ?, ?)",
      ).bind(monitorId, checkedAt, status, latencyMs),
    ),
  );
}

async function rows(table: "heartbeat_hourly" | "heartbeat_daily"): Promise<RollupRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM ${table} ORDER BY monitor_id, bucket_start`,
  ).all<RollupRow>();
  return results;
}

describe("rollupAndPrune", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM heartbeats"),
      env.DB.prepare("DELETE FROM heartbeat_hourly"),
      env.DB.prepare("DELETE FROM heartbeat_daily"),
      env.DB.prepare("DELETE FROM monitors"),
    ]);
  });

  it("aggregates each closed hour into one row per monitor", async () => {
    const id = await newMonitor("hourly");
    await seedHeartbeats(id, [
      [HOUR_START - 2 * HOUR + 5, "up", 100],
      [HOUR_START - 2 * HOUR + 65, "down", null],
      [HOUR_START - HOUR + 5, "up", 10],
      [HOUR_START - HOUR + 65, "up", 20],
      [HOUR_START - HOUR + 125, "up", 30],
      [HOUR_START - HOUR + 185, "up", 40],
      [HOUR_START - HOUR + 245, "down", null],
    ]);

    await rollupAndPrune(env.DB, HOUR_START + 800);

    expect(await rows("heartbeat_hourly")).toEqual([
      {
        monitor_id: id,
        bucket_start: HOUR_START - 2 * HOUR,
        up_count: 1,
        down_count: 1,
        latency_p50: 100,
        latency_p95: 100,
      },
      {
        monitor_id: id,
        bucket_start: HOUR_START - HOUR,
        up_count: 4,
        down_count: 1,
        latency_p50: 20,
        latency_p95: 40,
      },
    ]);
  });

  it("leaves the hour that is still open alone", async () => {
    const id = await newMonitor("open");
    await seedHeartbeats(id, [
      [HOUR_START - HOUR + 5, "up", 15],
      [HOUR_START + 10, "up", 15],
      [HOUR_START + 700, "up", 15],
    ]);

    await rollupAndPrune(env.DB, HOUR_START + 800);

    const hourly = await rows("heartbeat_hourly");
    expect(hourly.map((row) => row.bucket_start)).toEqual([HOUR_START - HOUR]);
  });

  it("overwrites instead of duplicating when it runs again", async () => {
    const id = await newMonitor("idempotent");
    await seedHeartbeats(id, [[HOUR_START - HOUR + 5, "up", 50]]);

    await rollupAndPrune(env.DB, HOUR_START + 800);
    await seedHeartbeats(id, [[HOUR_START - HOUR + 65, "down", null]]);
    await rollupAndPrune(env.DB, HOUR_START + 800);

    expect(await rows("heartbeat_hourly")).toEqual([
      {
        monitor_id: id,
        bucket_start: HOUR_START - HOUR,
        up_count: 1,
        down_count: 1,
        latency_p50: 50,
        latency_p95: 50,
      },
    ]);
  });

  it("rolls the finished day up from raw heartbeats at midnight", async () => {
    const id = await newMonitor("daily");
    await seedHeartbeats(id, [
      [DAY_START - DAY + 60, "up", 10],
      [DAY_START - DAY + 12 * HOUR, "up", 30],
      [DAY_START - DAY + 20 * HOUR, "down", null],
      [DAY_START + 60, "up", 999],
    ]);

    await rollupAndPrune(env.DB, DAY_START);

    expect(await rows("heartbeat_daily")).toEqual([
      {
        monitor_id: id,
        bucket_start: DAY_START - DAY,
        up_count: 2,
        down_count: 1,
        latency_p50: 10,
        latency_p95: 30,
      },
    ]);
  });

  it("does not touch the daily table outside the midnight tick", async () => {
    const id = await newMonitor("noon");
    await seedHeartbeats(id, [[DAY_START - DAY + 60, "up", 10]]);

    await rollupAndPrune(env.DB, DAY_START + 13 * HOUR);

    expect(await rows("heartbeat_daily")).toEqual([]);
  });

  it("prunes each table at its own retention horizon", async () => {
    const id = await newMonitor("retention");
    await seedHeartbeats(id, [
      [HOUR_START - 8 * DAY, "up", 10],
      [HOUR_START - HOUR + 5, "up", 10],
    ]);
    await env.DB.batch([
      env.DB
        .prepare("INSERT INTO heartbeat_hourly (monitor_id, bucket_start, up_count) VALUES (?, ?, 1)")
        .bind(id, HOUR_START - 91 * DAY),
      env.DB
        .prepare("INSERT INTO heartbeat_daily (monitor_id, bucket_start, up_count) VALUES (?, ?, 1)")
        .bind(id, HOUR_START - 800 * DAY),
      env.DB
        .prepare("INSERT INTO heartbeat_daily (monitor_id, bucket_start, up_count) VALUES (?, ?, 1)")
        .bind(id, HOUR_START - 30 * DAY),
    ]);

    await rollupAndPrune(env.DB, HOUR_START + 800);

    const { results: heartbeats } = await env.DB.prepare(
      "SELECT checked_at FROM heartbeats ORDER BY checked_at",
    ).all<{ checked_at: number }>();
    expect(heartbeats.map((row) => row.checked_at)).toEqual([HOUR_START - HOUR + 5]);

    expect((await rows("heartbeat_hourly")).map((row) => row.bucket_start)).toEqual([
      HOUR_START - HOUR,
    ]);
    expect((await rows("heartbeat_daily")).map((row) => row.bucket_start)).toEqual([
      HOUR_START - 30 * DAY,
    ]);
  });
});
