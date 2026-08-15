import { describe, expect, it } from "vitest";
import type { AdminMonitor } from "../src/db";
import type { LiveStatus } from "../src/monitor-hub";
import type { StatusMonitor, StatusPayload } from "../src/status";
import { BAR_LIMIT, patchBar, patchMonitors, patchStatus, parseFrame } from "@/lib/live";

const NOW = 1_700_000_000;

function monitor(overrides: Partial<StatusMonitor> = {}): StatusMonitor {
  return {
    id: 1,
    name: "API",
    type: "http",
    status: "up",
    last_checked_at: NOW - 60,
    latency_ms: 120,
    uptime: 99.9,
    heartbeats: [{ checked_at: NOW - 60, status: "up", latency_ms: 120 }],
    ...overrides,
  };
}

function payload(monitors: StatusMonitor[]): StatusPayload {
  return {
    name: "Acme Status",
    generated_at: NOW,
    window: "24h",
    overall: "up",
    monitors_up: monitors.filter((m) => m.status === "up").length,
    monitors_total: monitors.length,
    groups: [{ id: null, name: "Services", monitors }],
    maintenance: [],
    incidents: [],
  };
}

function update(overrides: Partial<LiveStatus> = {}): LiveStatus {
  return { monitor_id: 1, status: "up", check: "up", latency_ms: 90, checked_at: NOW, ...overrides };
}

describe("parseFrame", () => {
  it("reads a status frame", () => {
    const updates = [update()];

    expect(parseFrame(JSON.stringify({ type: "status", updates }))).toEqual({
      type: "status",
      updates,
    });
  });

  it("ignores the keepalive answer, junk, and a frame of another type", () => {
    expect(parseFrame("pong")).toBeNull();
    expect(parseFrame("{oops")).toBeNull();
    expect(parseFrame(JSON.stringify({ type: "hello", updates: [] }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: "status" }))).toBeNull();
    expect(parseFrame(JSON.stringify([1, 2]))).toBeNull();
    expect(parseFrame(new ArrayBuffer(4))).toBeNull();
  });
});

describe("patchStatus", () => {
  it("moves the monitor's status, latency and last check", () => {
    const next = patchStatus(payload([monitor()]), [
      update({ status: "down", check: "down", latency_ms: null }),
    ]);

    expect(next.groups[0].monitors[0]).toMatchObject({
      status: "down",
      latency_ms: null,
      last_checked_at: NOW,
    });
  });

  it("appends one heartbeat carrying the check, not the monitor status", () => {
    const next = patchStatus(payload([monitor()]), [update({ status: "up", check: "down" })]);

    expect(next.groups[0].monitors[0].heartbeats).toEqual([
      { checked_at: NOW - 60, status: "up", latency_ms: 120 },
      { checked_at: NOW, status: "down", latency_ms: 90 },
    ]);
  });

  it("keeps the bar at its limit by dropping the oldest segment", () => {
    const full = monitor({
      heartbeats: Array.from({ length: BAR_LIMIT }, (_, index) => ({
        checked_at: NOW - (BAR_LIMIT - index) * 60,
        status: "up" as const,
        latency_ms: 100,
      })),
    });

    const bar = patchStatus(payload([full]), [update()]).groups[0].monitors[0].heartbeats;

    expect(bar).toHaveLength(BAR_LIMIT);
    expect(bar[BAR_LIMIT - 1].checked_at).toBe(NOW);
    expect(bar[0].checked_at).toBe(NOW - (BAR_LIMIT - 1) * 60);
  });

  it("recomputes the page's own words", () => {
    const two = [monitor(), monitor({ id: 2, name: "Web" })];

    const partial = patchStatus(payload(two), [
      update({ monitor_id: 2, status: "down", check: "down" }),
    ]);
    expect(partial).toMatchObject({ overall: "partial", monitors_up: 1 });

    const allDown = patchStatus(partial, [update({ monitor_id: 1, status: "down", check: "down" })]);
    expect(allDown).toMatchObject({ overall: "down", monitors_up: 0 });
  });

  it("leaves the monitors an update did not name alone", () => {
    const before = payload([monitor(), monitor({ id: 2, name: "Web" })]);

    const next = patchStatus(before, [update({ monitor_id: 2, status: "down", check: "down" })]);

    expect(next.groups[0].monitors[0]).toBe(before.groups[0].monitors[0]);
  });

  it("ignores an update for a monitor the page cannot see", () => {
    const before = payload([monitor()]);

    expect(patchStatus(before, [update({ monitor_id: 99 })])).toEqual(before);
    expect(patchStatus(before, [])).toBe(before);
  });
});

describe("patchMonitors", () => {
  const row = { id: 1, name: "API", status: "up", last_checked_at: NOW - 60 } as AdminMonitor;
  const other = { id: 2, name: "Web", status: "up", last_checked_at: null } as AdminMonitor;

  it("moves the status and the last check of the named row only", () => {
    const next = patchMonitors([row, other], [update({ status: "down", check: "down" })]);

    expect(next[0]).toMatchObject({ status: "down", last_checked_at: NOW });
    expect(next[1]).toBe(other);
  });

  it("ignores an unknown id", () => {
    const rows = [row];

    expect(patchMonitors(rows, [update({ monitor_id: 99 })])).toBe(rows);
  });
});

describe("patchBar", () => {
  const bar = [{ checked_at: NOW - 60, status: "up" as const, latency_ms: 120, message: "200" }];

  it("appends the open monitor's check with no message of its own", () => {
    expect(patchBar(bar, 1, [update({ check: "down" })])).toEqual([
      bar[0],
      { checked_at: NOW, status: "down", latency_ms: 90, message: null },
    ]);
  });

  it("ignores a check for another monitor", () => {
    expect(patchBar(bar, 2, [update()])).toBe(bar);
  });

  it("keeps the bar at its limit", () => {
    const full = Array.from({ length: BAR_LIMIT }, (_, index) => ({
      checked_at: NOW - (BAR_LIMIT - index) * 60,
      status: "up" as const,
      latency_ms: 100,
      message: null,
    }));

    expect(patchBar(full, 1, [update()])).toHaveLength(BAR_LIMIT);
  });
});
