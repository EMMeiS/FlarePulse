import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Monitor } from "../src/db";
import { createMonitor, listMonitors, recentHeartbeats } from "../src/db";
import { nextState } from "../src/checker";
import worker from "../src/index";

function monitor(overrides: Partial<Monitor> = {}): Monitor {
  return {
    id: 1,
    name: "example",
    type: "http",
    target: "https://example.com",
    interval_seconds: 60,
    timeout_ms: 10_000,
    retries: 2,
    expected_status: null,
    keyword: null,
    keyword_invert: 0,
    group_id: null,
    enabled: 1,
    status: "pending",
    fail_streak: 0,
    next_check_at: 0,
    last_checked_at: null,
    created_at: 0,
    ...overrides,
  };
}

describe("nextState", () => {
  it("clears the fail streak and reports up on a successful check", () => {
    expect(nextState(monitor({ status: "down", fail_streak: 5 }), "up", 1_000)).toEqual({
      monitorStatus: "up",
      failStreak: 0,
      nextCheckAt: 1_060,
    });
  });

  it("counts failures without flipping while the streak is within retries", () => {
    const first = nextState(monitor({ status: "up" }), "down", 1_000);
    expect(first).toEqual({ monitorStatus: "up", failStreak: 1, nextCheckAt: 1_060 });

    const second = nextState(monitor({ status: "up", fail_streak: 1 }), "down", 1_060);
    expect(second).toEqual({ monitorStatus: "up", failStreak: 2, nextCheckAt: 1_120 });
  });

  it("flips to down once the streak exceeds retries", () => {
    expect(nextState(monitor({ status: "up", fail_streak: 2 }), "down", 1_000)).toEqual({
      monitorStatus: "down",
      failStreak: 3,
      nextCheckAt: 1_060,
    });
  });

  it("flips on the first failure when retries is 0", () => {
    expect(nextState(monitor({ status: "up", retries: 0 }), "down", 1_000).monitorStatus).toBe(
      "down",
    );
  });

  it("keeps a never-checked monitor pending through its retry window", () => {
    expect(nextState(monitor(), "down", 1_000)).toEqual({
      monitorStatus: "pending",
      failStreak: 1,
      nextCheckAt: 1_060,
    });
  });

  it("stays down and keeps counting while a down monitor keeps failing", () => {
    expect(nextState(monitor({ status: "down", fail_streak: 9 }), "down", 1_000)).toEqual({
      monitorStatus: "down",
      failStreak: 10,
      nextCheckAt: 1_060,
    });
  });

  it("schedules the next check one interval after this one", () => {
    expect(nextState(monitor({ interval_seconds: 300 }), "up", 5_000).nextCheckAt).toBe(5_300);
  });
});

const NOW = 1_700_000_000;
// The hour boundary just before NOW, so "on the hour" is exact in the tests.
const HOUR_START = 1_699_999_200;

async function hourlyRowCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM heartbeat_hourly").first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

function respondPerHost(byHost: Record<string, Response | Error>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).host;
    const reply = byHost[host];
    if (!reply) throw new Error(`unexpected fetch to ${host}`);
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  });
}

async function tick(scheduledTime = NOW) {
  const ctx = createExecutionContext();
  await worker.scheduled(
    createScheduledController({ scheduledTime: new Date(scheduledTime * 1_000), cron: "* * * * *" }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
}

function byId(monitors: Monitor[], id: number): Monitor {
  const found = monitors.find((m) => m.id === id);
  if (!found) throw new Error(`monitor ${id} vanished`);
  return found;
}

describe("the cron tick", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM heartbeats"),
      env.DB.prepare("DELETE FROM heartbeat_hourly"),
      env.DB.prepare("DELETE FROM heartbeat_daily"),
      env.DB.prepare("DELETE FROM monitors"),
    ]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("checks every due monitor, records it, and leaves the rest alone", async () => {
    const overdue = await createMonitor(env.DB, {
      name: "overdue",
      type: "http",
      target: "https://up.test/",
      next_check_at: NOW - 120,
    });
    const due = await createMonitor(env.DB, {
      name: "due",
      type: "http",
      target: "https://broken.test/",
      next_check_at: NOW,
    });
    const later = await createMonitor(env.DB, {
      name: "later",
      type: "http",
      target: "https://later.test/",
      next_check_at: NOW + 300,
    });
    const off = await createMonitor(env.DB, {
      name: "disabled",
      type: "http",
      target: "https://off.test/",
      enabled: false,
      next_check_at: 0,
    });

    respondPerHost({
      "up.test": new Response("ok"),
      "broken.test": new Response("boom", { status: 500 }),
    });

    await tick();

    await expect(recentHeartbeats(env.DB, overdue.id)).resolves.toMatchObject([
      { status: "up", checked_at: NOW, message: "200" },
    ]);
    await expect(recentHeartbeats(env.DB, due.id)).resolves.toMatchObject([
      { status: "down", checked_at: NOW, message: "500" },
    ]);
    await expect(recentHeartbeats(env.DB, later.id)).resolves.toEqual([]);
    await expect(recentHeartbeats(env.DB, off.id)).resolves.toEqual([]);

    const after = await listMonitors(env.DB);
    expect(byId(after, overdue.id)).toMatchObject({
      status: "up",
      fail_streak: 0,
      next_check_at: NOW + 60,
      last_checked_at: NOW,
    });
    // One failure with the default of 2 retries is not down yet.
    expect(byId(after, due.id)).toMatchObject({
      status: "pending",
      fail_streak: 1,
      next_check_at: NOW + 60,
    });
    expect(byId(after, later.id)).toMatchObject({ next_check_at: NOW + 300, last_checked_at: null });
    expect(byId(after, off.id)).toMatchObject({ next_check_at: 0, last_checked_at: null });
  });

  it("pushes the live status into MonitorHub", async () => {
    const created = await createMonitor(env.DB, {
      name: "live",
      type: "http",
      target: "https://up.test/",
      next_check_at: NOW,
    });
    respondPerHost({ "up.test": new Response("ok") });

    await tick();

    const hub = env.MONITOR_HUB.get(env.MONITOR_HUB.idFromName("global"));
    await expect(hub.snapshot()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ monitor_id: created.id, status: "up", checked_at: NOW }),
      ]),
    );
  });

  /** The live dot follows the monitor, so a failure inside the window is not one. */
  it("pushes the monitor's status rather than the failing check", async () => {
    const created = await createMonitor(env.DB, {
      name: "flaky",
      type: "http",
      target: "https://broken.test/",
      next_check_at: NOW,
    });
    respondPerHost({ "broken.test": new Response("boom", { status: 500 }) });

    await tick();

    const hub = env.MONITOR_HUB.get(env.MONITOR_HUB.idFromName("global"));
    await expect(hub.snapshot()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ monitor_id: created.id, status: "pending", checked_at: NOW }),
      ]),
    );
  });

  it("keeps going when one monitor's probe blows up", async () => {
    const broken = await createMonitor(env.DB, {
      name: "throws",
      type: "http",
      target: "https://dns-fail.test/",
      next_check_at: NOW,
    });
    const healthy = await createMonitor(env.DB, {
      name: "fine",
      type: "http",
      target: "https://up.test/",
      next_check_at: NOW,
    });

    respondPerHost({
      "dns-fail.test": new Error("no such host"),
      "up.test": new Response("ok"),
    });

    await tick();

    await expect(recentHeartbeats(env.DB, broken.id)).resolves.toMatchObject([
      { status: "down", message: "no such host" },
    ]);
    await expect(recentHeartbeats(env.DB, healthy.id)).resolves.toMatchObject([{ status: "up" }]);
  });

  it("does nothing at all when no monitor is due", async () => {
    await createMonitor(env.DB, {
      name: "later",
      type: "http",
      target: "https://later.test/",
      next_check_at: NOW + 60,
    });
    const spy = respondPerHost({});

    await tick();

    expect(spy).not.toHaveBeenCalled();
  });

  it("runs the rollup pass on the hour and not on the other 59 ticks", async () => {
    const monitorId = (
      await createMonitor(env.DB, {
        name: "rollup",
        type: "http",
        target: "https://later.test/",
        next_check_at: NOW + 3_600,
      })
    ).id;
    await env.DB
      .prepare(
        "INSERT INTO heartbeats (monitor_id, checked_at, status, latency_ms) VALUES (?, ?, 'up', 42)",
      )
      .bind(monitorId, HOUR_START - 1_800)
      .run();
    respondPerHost({});

    await tick(HOUR_START + 130);
    await expect(hourlyRowCount()).resolves.toBe(0);

    await tick(HOUR_START + 20);
    await expect(hourlyRowCount()).resolves.toBe(1);
  });
});
