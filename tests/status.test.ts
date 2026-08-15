import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMonitor } from "../src/db";
import {
  activeMaintenance,
  heartbeatBars,
  publicMonitor,
  publicMonitors,
  recentIncidents,
  rolledBuckets,
  uptimeSince,
} from "../src/db";
import type { MonitorHistory, StatusPayload } from "../src/status";
import { overallStatus, uptimePercent, windowSource } from "../src/status";
import { badgeSvg } from "../src/badge";
import worker from "../src/index";

// The status endpoints read the wall clock, so the fixtures are anchored to it
// rather than to a fixed epoch.
const NOW = Math.floor(Date.now() / 1_000);
const HOUR = 3_600;
const DAY = 86_400;

async function seedGroup(
  name: string,
  { isPublic = true, position = 0 }: { isPublic?: boolean; position?: number } = {},
): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO monitor_groups (name, position, is_public) VALUES (?, ?, ?) RETURNING id",
  )
    .bind(name, position, isPublic ? 1 : 0)
    .first<{ id: number }>();
  if (!row) throw new Error("group insert returned no row");
  return row.id;
}

async function seedHeartbeats(
  monitorId: number,
  beats: Array<[checkedAt: number, status: "up" | "down", latencyMs: number | null]>,
): Promise<void> {
  await env.DB.batch(
    beats.map(([checkedAt, status, latencyMs]) =>
      env.DB.prepare(
        "INSERT INTO heartbeats (monitor_id, checked_at, status, latency_ms) VALUES (?, ?, ?, ?)",
      ).bind(monitorId, checkedAt, status, latencyMs),
    ),
  );
}

async function get(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://flarepulse.test${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function clean(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM heartbeats"),
    env.DB.prepare("DELETE FROM heartbeat_hourly"),
    env.DB.prepare("DELETE FROM heartbeat_daily"),
    env.DB.prepare("DELETE FROM incidents"),
    env.DB.prepare("DELETE FROM maintenance_windows"),
    env.DB.prepare("DELETE FROM monitors"),
    env.DB.prepare("DELETE FROM monitor_groups"),
  ]);
}

describe("the pure parts of the payload", () => {
  it("summarises a page from the statuses on it", () => {
    expect(overallStatus(["up", "up"])).toBe("up");
    expect(overallStatus(["down", "down"])).toBe("down");
    expect(overallStatus(["up", "down", "up"])).toBe("partial");
    expect(overallStatus([])).toBe("pending");
    expect(overallStatus(["pending", "pending"])).toBe("pending");
  });

  it("ignores never-checked monitors when summarising", () => {
    // A monitor that has never reported is not evidence either way.
    expect(overallStatus(["up", "pending"])).toBe("up");
    expect(overallStatus(["down", "pending"])).toBe("down");
    expect(overallStatus(["up", "down", "pending"])).toBe("partial");
  });

  it("computes uptime as a percentage, or nothing at all with no samples", () => {
    expect(uptimePercent(0, 0)).toBeNull();
    expect(uptimePercent(10, 0)).toBe(100);
    expect(uptimePercent(0, 10)).toBe(0);
    expect(uptimePercent(2_879, 1)).toBe(99.97);
  });

  it("resolves each window to exactly one source", () => {
    expect(windowSource("24h")).toEqual({
      window: "24h",
      source: "heartbeats",
      bucketSize: HOUR,
      span: DAY,
    });
    expect(windowSource("7d")).toEqual({
      window: "7d",
      source: "heartbeat_hourly",
      bucketSize: HOUR,
      span: 7 * DAY,
    });
    expect(windowSource("30d")).toEqual({
      window: "30d",
      source: "heartbeat_daily",
      bucketSize: DAY,
      span: 30 * DAY,
    });
    expect(windowSource("90d")).toMatchObject({ source: "heartbeat_daily", span: 90 * DAY });
  });

  it("falls back to 24h rather than failing on a window it does not know", () => {
    expect(windowSource("all-time").window).toBe("24h");
    expect(windowSource(null).window).toBe("24h");
  });
});

describe("the incidents and maintenance tables", () => {
  beforeEach(clean);

  it("opens an incident as investigating, unresolved, with a timestamp", async () => {
    await env.DB.prepare("INSERT INTO incidents (title) VALUES ('Edge cache misses')").run();

    const [incident] = await recentIncidents(env.DB);

    expect(incident).toMatchObject({
      title: "Edge cache misses",
      status: "investigating",
      body: null,
      monitor_id: null,
      resolved_at: null,
    });
    expect(incident?.started_at).toBeGreaterThanOrEqual(NOW);
  });

  it("refuses an incident status outside the four the timeline renders", async () => {
    await expect(
      env.DB.prepare("INSERT INTO incidents (title, status) VALUES ('x', 'on fire')").run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("lists incidents newest first", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO incidents (title, started_at) VALUES ('older', ?)").bind(NOW - DAY),
      env.DB.prepare("INSERT INTO incidents (title, started_at) VALUES ('newer', ?)").bind(NOW),
    ]);

    await expect(recentIncidents(env.DB)).resolves.toMatchObject([
      { title: "newer" },
      { title: "older" },
    ]);
  });

  it("keeps running and upcoming maintenance, drops what has ended", async () => {
    await env.DB.batch([
      env.DB
        .prepare("INSERT INTO maintenance_windows (title, starts_at, ends_at) VALUES ('now', ?, ?)")
        .bind(NOW - HOUR, NOW + HOUR),
      env.DB
        .prepare("INSERT INTO maintenance_windows (title, starts_at, ends_at) VALUES ('soon', ?, ?)")
        .bind(NOW + DAY, NOW + DAY + HOUR),
      env.DB
        .prepare("INSERT INTO maintenance_windows (title, starts_at, ends_at) VALUES ('over', ?, ?)")
        .bind(NOW - DAY, NOW - DAY + HOUR),
    ]);

    await expect(activeMaintenance(env.DB, NOW)).resolves.toMatchObject([
      { title: "now" },
      { title: "soon" },
    ]);
  });
});

describe("the status page read queries", () => {
  beforeEach(clean);

  it("shows public and ungrouped monitors, hides private groups and disabled monitors", async () => {
    const shown = await seedGroup("Shown", { position: 1 });
    const hidden = await seedGroup("Hidden", { isPublic: false });

    const api = await createMonitor(env.DB, {
      name: "api",
      type: "http",
      target: "https://internal.example/secret",
      group_id: shown,
    });
    const loose = await createMonitor(env.DB, { name: "loose", type: "http", target: "https://x/" });
    await createMonitor(env.DB, {
      name: "secret",
      type: "http",
      target: "https://x/",
      group_id: hidden,
    });
    await createMonitor(env.DB, {
      name: "paused",
      type: "http",
      target: "https://x/",
      group_id: shown,
      enabled: false,
    });

    const rows = await publicMonitors(env.DB);

    expect(rows.map((row) => row.name)).toEqual(["api", "loose"]);
    expect(rows[0]).toMatchObject({ id: api.id, group_id: shown, group_name: "Shown" });
    expect(rows[1]).toMatchObject({ id: loose.id, group_id: null, group_name: null });
    // A target is an internal hostname often enough that it never leaves the Worker.
    expect(JSON.stringify(rows)).not.toContain("secret");
  });

  it("answers whether one monitor is publicly visible", async () => {
    const hidden = await seedGroup("Hidden", { isPublic: false });
    const open = await createMonitor(env.DB, { name: "open", type: "http", target: "https://x/" });
    const closed = await createMonitor(env.DB, {
      name: "closed",
      type: "http",
      target: "https://x/",
      group_id: hidden,
    });

    await expect(publicMonitor(env.DB, open.id)).resolves.toMatchObject({ name: "open" });
    await expect(publicMonitor(env.DB, closed.id)).resolves.toBeNull();
    await expect(publicMonitor(env.DB, 9_999)).resolves.toBeNull();
  });

  it("counts up and down per monitor from raw heartbeats in one query", async () => {
    const a = await createMonitor(env.DB, { name: "a", type: "http", target: "https://x/" });
    const b = await createMonitor(env.DB, { name: "b", type: "http", target: "https://x/" });
    await seedHeartbeats(a.id, [
      [NOW - 120, "up", 10],
      [NOW - 60, "down", null],
      [NOW - 2 * DAY, "up", 10], // outside the window
    ]);
    await seedHeartbeats(b.id, [[NOW - 60, "up", 20]]);

    const counts = await uptimeSince(env.DB, [a.id, b.id], NOW - DAY, "heartbeats");

    expect(counts).toEqual(
      expect.arrayContaining([
        { monitor_id: a.id, up_count: 1, down_count: 1 },
        { monitor_id: b.id, up_count: 1, down_count: 0 },
      ]),
    );
    expect(counts).toHaveLength(2);
  });

  it("counts up and down from a rollup table for the long windows", async () => {
    const a = await createMonitor(env.DB, { name: "a", type: "http", target: "https://x/" });
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO heartbeat_daily (monitor_id, bucket_start, up_count, down_count)
           VALUES (?, ?, 1400, 40)`,
        )
        .bind(a.id, NOW - DAY),
      env.DB
        .prepare(
          `INSERT INTO heartbeat_daily (monitor_id, bucket_start, up_count, down_count)
           VALUES (?, ?, 1440, 0)`,
        )
        .bind(a.id, NOW - 2 * DAY),
      env.DB
        .prepare(
          `INSERT INTO heartbeat_daily (monitor_id, bucket_start, up_count, down_count)
           VALUES (?, ?, 999, 999)`,
        )
        .bind(a.id, NOW - 40 * DAY), // outside the window
    ]);

    await expect(
      uptimeSince(env.DB, [a.id], NOW - 30 * DAY, "heartbeat_daily"),
    ).resolves.toEqual([{ monitor_id: a.id, up_count: 2840, down_count: 40 }]);
  });

  it("returns the newest N heartbeats per monitor, oldest first, in one query", async () => {
    const a = await createMonitor(env.DB, { name: "a", type: "http", target: "https://x/" });
    const b = await createMonitor(env.DB, { name: "b", type: "http", target: "https://x/" });
    await seedHeartbeats(a.id, [
      [NOW - 180, "up", 10],
      [NOW - 120, "down", null],
      [NOW - 60, "up", 30],
    ]);
    await seedHeartbeats(b.id, [[NOW - 60, "up", 40]]);

    const bars = await heartbeatBars(env.DB, [a.id, b.id], 2);

    expect(bars.filter((bar) => bar.monitor_id === a.id)).toEqual([
      { monitor_id: a.id, checked_at: NOW - 120, status: "down", latency_ms: null },
      { monitor_id: a.id, checked_at: NOW - 60, status: "up", latency_ms: 30 },
    ]);
    expect(bars.filter((bar) => bar.monitor_id === b.id)).toHaveLength(1);
  });

  it("has no query to run when nothing is public", async () => {
    await expect(uptimeSince(env.DB, [], NOW - DAY, "heartbeats")).resolves.toEqual([]);
    await expect(heartbeatBars(env.DB, [], 10)).resolves.toEqual([]);
  });

  it("reads pre-computed buckets for the long windows", async () => {
    const a = await createMonitor(env.DB, { name: "a", type: "http", target: "https://x/" });
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO heartbeat_hourly (monitor_id, bucket_start, up_count, down_count, latency_p50, latency_p95)
           VALUES (?, ?, 60, 0, 12, 30)`,
        )
        .bind(a.id, NOW - HOUR),
      env.DB
        .prepare(
          `INSERT INTO heartbeat_hourly (monitor_id, bucket_start, up_count, down_count, latency_p50, latency_p95)
           VALUES (?, ?, 59, 1, 14, 90)`,
        )
        .bind(a.id, NOW - 2 * HOUR),
      env.DB
        .prepare(
          `INSERT INTO heartbeat_hourly (monitor_id, bucket_start, up_count, down_count, latency_p50, latency_p95)
           VALUES (?, ?, 60, 0, 1, 1)`,
        )
        .bind(a.id, NOW - 10 * HOUR), // outside the window
    ]);

    await expect(rolledBuckets(env.DB, a.id, NOW - 3 * HOUR, "heartbeat_hourly")).resolves.toEqual([
      {
        monitor_id: a.id,
        bucket_start: NOW - 2 * HOUR,
        up_count: 59,
        down_count: 1,
        latency_p50: 14,
        latency_p95: 90,
      },
      {
        monitor_id: a.id,
        bucket_start: NOW - HOUR,
        up_count: 60,
        down_count: 0,
        latency_p50: 12,
        latency_p95: 30,
      },
    ]);
  });
});

describe("GET /api/status", () => {
  beforeEach(clean);

  it("renders a whole page from one request", async () => {
    const shown = await seedGroup("Core", { position: 1 });
    const hidden = await seedGroup("Internal", { isPublic: false });

    const api = await createMonitor(env.DB, {
      name: "api",
      type: "http",
      target: "https://internal.example/private-path",
      group_id: shown,
    });
    const dns = await createMonitor(env.DB, { name: "dns", type: "dns", target: "example.com" });
    await createMonitor(env.DB, {
      name: "vault",
      type: "http",
      target: "https://vault.internal/",
      group_id: hidden,
    });

    await env.DB.batch([
      env.DB.prepare("UPDATE monitors SET status = 'up', last_checked_at = ? WHERE id = ?").bind(NOW - 60, api.id),
      env.DB.prepare("UPDATE monitors SET status = 'down', last_checked_at = ? WHERE id = ?").bind(NOW - 60, dns.id),
    ]);
    await seedHeartbeats(api.id, [
      [NOW - 180, "up", 90],
      [NOW - 120, "down", null],
      [NOW - 60, "up", 110],
    ]);
    await seedHeartbeats(dns.id, [[NOW - 60, "down", null]]);

    const response = await get("/api/status");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as StatusPayload;

    expect(payload).toMatchObject({
      window: "24h",
      overall: "partial",
      monitors_up: 1,
      monitors_total: 2,
    });
    expect(payload.groups.map((group) => group.name)).toEqual(["Core", "Services"]);
    expect(payload.groups[0]?.monitors[0]).toMatchObject({
      id: api.id,
      name: "api",
      type: "http",
      status: "up",
      latency_ms: 110,
      uptime: 66.67,
    });
    expect(payload.groups[0]?.monitors[0]?.heartbeats).toEqual([
      { checked_at: NOW - 180, status: "up", latency_ms: 90 },
      { checked_at: NOW - 120, status: "down", latency_ms: null },
      { checked_at: NOW - 60, status: "up", latency_ms: 110 },
    ]);
    expect(payload.groups[1]?.monitors.map((monitor) => monitor.name)).toEqual(["dns"]);
  });

  it("never publishes a monitor target or a private group", async () => {
    const hidden = await seedGroup("Internal", { isPublic: false });
    await createMonitor(env.DB, {
      name: "vault",
      type: "http",
      target: "https://vault.internal/",
      group_id: hidden,
    });
    await createMonitor(env.DB, { name: "site", type: "http", target: "https://site.example/" });

    const body = await (await get("/api/status")).text();

    expect(body).not.toContain("vault");
    expect(body).not.toContain("Internal");
    expect(body).not.toContain("site.example");
    expect(body).toContain("site");
  });

  it("carries maintenance and incidents for the banner and the timeline", async () => {
    await env.DB.batch([
      env.DB
        .prepare("INSERT INTO maintenance_windows (title, body, starts_at, ends_at) VALUES ('DB upgrade', 'Brief blips', ?, ?)")
        .bind(NOW + HOUR, NOW + 2 * HOUR),
      env.DB
        .prepare("INSERT INTO incidents (title, status, started_at, resolved_at) VALUES ('Cache stampede', 'resolved', ?, ?)")
        .bind(NOW - DAY, NOW - DAY + HOUR),
    ]);

    const payload = (await (await get("/api/status")).json()) as StatusPayload;

    expect(payload.maintenance).toMatchObject([{ title: "DB upgrade", body: "Brief blips" }]);
    expect(payload.incidents).toMatchObject([{ title: "Cache stampede", status: "resolved" }]);
  });

  it("falls back to 24h for an unknown window and asks for a short cache", async () => {
    const response = await get("/api/status?window=forever");

    expect(response.headers.get("cache-control")).toBe("public, max-age=30");
    expect(((await response.json()) as StatusPayload).window).toBe("24h");
  });

  it("uses the daily rollup for the long windows", async () => {
    const monitor = await createMonitor(env.DB, { name: "a", type: "http", target: "https://x/" });
    await env.DB
      .prepare(
        `INSERT INTO heartbeat_daily (monitor_id, bucket_start, up_count, down_count)
         VALUES (?, ?, 999, 1)`,
      )
      .bind(monitor.id, NOW - 10 * DAY)
      .run();
    // Raw heartbeats a 30d window must not be reading, or the number would move.
    await seedHeartbeats(monitor.id, [[NOW - 60, "down", null]]);

    const payload = (await (await get("/api/status?window=30d")).json()) as StatusPayload;

    expect(payload.window).toBe("30d");
    expect(payload.groups[0]?.monitors[0]?.uptime).toBe(99.9);
  });

  it("says pending rather than lying about an empty install", async () => {
    const payload = (await (await get("/api/status")).json()) as StatusPayload;

    expect(payload).toMatchObject({ overall: "pending", monitors_total: 0, groups: [] });
    expect(payload.generated_at).toBeGreaterThanOrEqual(NOW);
  });
});

// Bucket boundaries are absolute, so the chart fixtures anchor to a real hour.
const HOUR_START = Math.floor(NOW / HOUR) * HOUR;

describe("GET /api/status/monitors/:id", () => {
  beforeEach(clean);

  it("buckets raw heartbeats by hour for the 24h window", async () => {
    const monitor = await createMonitor(env.DB, { name: "api", type: "http", target: "https://x/" });
    await seedHeartbeats(monitor.id, [
      [HOUR_START - 2 * HOUR, "up", 10],
      [HOUR_START - 2 * HOUR + 60, "up", 20],
      [HOUR_START - 2 * HOUR + 120, "up", 30],
      [HOUR_START - 2 * HOUR + 180, "up", 40],
      [HOUR_START - HOUR, "down", null],
      [HOUR_START - HOUR + 60, "up", 100],
    ]);

    const response = await get(`/api/status/monitors/${monitor.id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    const history = (await response.json()) as MonitorHistory;

    expect(history).toMatchObject({
      window: "24h",
      bucket_size: HOUR,
      uptime: 83.33,
      monitor: { id: monitor.id, name: "api", type: "http" },
    });
    expect(history.points).toEqual([
      {
        start: HOUR_START - 2 * HOUR,
        up: 4,
        down: 0,
        uptime: 100,
        latency_p50: 20,
        latency_p95: 40,
      },
      { start: HOUR_START - HOUR, up: 1, down: 1, uptime: 50, latency_p50: 100, latency_p95: 100 },
    ]);
  });

  it("reads the hourly rollup for 7d and the daily one for 90d", async () => {
    const monitor = await createMonitor(env.DB, { name: "api", type: "http", target: "https://x/" });
    // Raw rows the long windows must ignore, or these numbers would move.
    await seedHeartbeats(monitor.id, [[HOUR_START - HOUR, "down", null]]);
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO heartbeat_hourly (monitor_id, bucket_start, up_count, down_count, latency_p50, latency_p95)
           VALUES (?, ?, 58, 2, 12, 40)`,
        )
        .bind(monitor.id, HOUR_START - 3 * HOUR),
      env.DB
        .prepare(
          `INSERT INTO heartbeat_daily (monitor_id, bucket_start, up_count, down_count, latency_p50, latency_p95)
           VALUES (?, ?, 1400, 40, 15, 60)`,
        )
        .bind(monitor.id, HOUR_START - 5 * DAY),
    ]);

    const weekly = (await (
      await get(`/api/status/monitors/${monitor.id}?window=7d`)
    ).json()) as MonitorHistory;
    expect(weekly).toMatchObject({ window: "7d", bucket_size: HOUR, uptime: 96.67 });
    expect(weekly.points).toEqual([
      {
        start: HOUR_START - 3 * HOUR,
        up: 58,
        down: 2,
        uptime: 96.67,
        latency_p50: 12,
        latency_p95: 40,
      },
    ]);

    const quarterly = (await (
      await get(`/api/status/monitors/${monitor.id}?window=90d`)
    ).json()) as MonitorHistory;
    expect(quarterly).toMatchObject({ window: "90d", bucket_size: DAY, uptime: 97.22 });
    expect(quarterly.points).toMatchObject([{ up: 1400, down: 40, latency_p95: 60 }]);
  });

  it("returns an empty series rather than an error for a monitor with no history", async () => {
    const monitor = await createMonitor(env.DB, { name: "new", type: "http", target: "https://x/" });

    const history = (await (
      await get(`/api/status/monitors/${monitor.id}`)
    ).json()) as MonitorHistory;

    expect(history).toMatchObject({ uptime: null, points: [] });
  });

  it("is a 404 for a private monitor, an unknown id and a non-numeric id", async () => {
    const hidden = await seedGroup("Internal", { isPublic: false });
    const secret = await createMonitor(env.DB, {
      name: "vault",
      type: "http",
      target: "https://x/",
      group_id: hidden,
    });

    for (const path of [
      `/api/status/monitors/${secret.id}`,
      "/api/status/monitors/9999",
      "/api/status/monitors/abc",
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ error: "not_found" });
    }
  });
});

describe("the embeddable badge", () => {
  beforeEach(clean);

  it("renders a shields-style SVG with the status colour", () => {
    const up = badgeSvg("api", "99.95%", "up");

    expect(up).toContain("<svg");
    expect(up).toContain("api");
    expect(up).toContain("99.95%");
    // Never colour-only: a screen reader gets the same sentence a sighted user reads.
    expect(up).toContain('role="img"');
    expect(up).toContain("<title>api: 99.95% (up)</title>");

    const down = badgeSvg("api", "80%", "down");
    const pending = badgeSvg("api", "no data", "pending");
    const colour = (svg: string) => svg.match(/fill="(#[0-9a-f]{6})"/g);
    expect(colour(up)).not.toEqual(colour(down));
    expect(colour(down)).not.toEqual(colour(pending));
  });

  it("grows with the text instead of clipping it", () => {
    const width = (svg: string) => Number(svg.match(/width="(\d+)"/)?.[1]);

    expect(width(badgeSvg("a-very-long-monitor-name", "99.95%", "up"))).toBeGreaterThan(
      width(badgeSvg("a", "99.95%", "up")),
    );
  });

  it("escapes text so a monitor name cannot break the document", () => {
    const svg = badgeSvg('A & B <script>', "100%", "up");

    expect(svg).not.toContain("<script>");
    expect(svg).toContain("A &amp; B &lt;script&gt;");
  });

  it("serves the badge for a public monitor", async () => {
    const monitor = await createMonitor(env.DB, { name: "api", type: "http", target: "https://x/" });
    await env.DB.prepare("UPDATE monitors SET status = 'up' WHERE id = ?").bind(monitor.id).run();
    await seedHeartbeats(monitor.id, [
      [NOW - 120, "up", 10],
      [NOW - 60, "up", 20],
    ]);

    const response = await get(`/api/badge/${monitor.id}.svg`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    const svg = await response.text();
    expect(svg).toContain("100%");
    expect(svg).toContain("api");
  });

  it("says so rather than lying when a monitor has no samples yet", async () => {
    const monitor = await createMonitor(env.DB, { name: "new", type: "http", target: "https://x/" });

    await expect((await get(`/api/badge/${monitor.id}.svg`)).text()).resolves.toContain("no data");
  });

  it("is a 404 for a private monitor and for a nonsense id", async () => {
    const hidden = await seedGroup("Internal", { isPublic: false });
    const secret = await createMonitor(env.DB, {
      name: "vault",
      type: "http",
      target: "https://x/",
      group_id: hidden,
    });

    expect((await get(`/api/badge/${secret.id}.svg`)).status).toBe(404);
    expect((await get("/api/badge/9999.svg")).status).toBe(404);
    expect((await get("/api/badge/abc.svg")).status).toBe(404);
  });
});
