import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { StatusUpdate } from "../src/monitor-hub";

// One instance per test, so tests do not inherit each other's rows without
// needing a test-only reset method on the class.
function hub(name: string) {
  return env.MONITOR_HUB.get(env.MONITOR_HUB.idFromName(name));
}

function update(overrides: Partial<StatusUpdate> = {}): StatusUpdate {
  return {
    monitorId: 1,
    status: "up",
    check: "up",
    latencyMs: 42,
    checkedAt: 1_000,
    isPublic: true,
    ...overrides,
  };
}

describe("MonitorHub", () => {
  it("keeps the latest status per monitor", async () => {
    const stub = hub("latest");

    await stub.setStatuses([
      update({ monitorId: 1 }),
      update({ monitorId: 2, status: "down", check: "down", latencyMs: null, checkedAt: 1_001 }),
    ]);

    await expect(stub.snapshot()).resolves.toEqual([
      { monitor_id: 1, status: "up", latency_ms: 42, checked_at: 1_000 },
      { monitor_id: 2, status: "down", latency_ms: null, checked_at: 1_001 },
    ]);
  });

  it("replaces the row for a monitor instead of appending", async () => {
    const stub = hub("replace");

    await stub.setStatuses([update({ monitorId: 7, latencyMs: 10 })]);
    await stub.setStatuses([
      update({ monitorId: 7, status: "down", check: "down", latencyMs: 900, checkedAt: 1_060 }),
    ]);

    await expect(stub.snapshot()).resolves.toEqual([
      { monitor_id: 7, status: "down", latency_ms: 900, checked_at: 1_060 },
    ]);
  });

  /**
   * The stored row is the monitor's status, not the check's: inside the retry
   * window a failing check must not show as a down monitor.
   */
  it("stores the monitor status rather than the raw check result", async () => {
    const stub = hub("retry-window");

    await stub.setStatuses([update({ monitorId: 5, status: "up", check: "down", latencyMs: null })]);

    await expect(stub.snapshot()).resolves.toEqual([
      { monitor_id: 5, status: "up", latency_ms: null, checked_at: 1_000 },
    ]);
  });

  it("does nothing when the tick found nothing", async () => {
    const stub = hub("empty");

    await stub.setStatuses([]);

    await expect(stub.snapshot()).resolves.toEqual([]);
  });

  it("survives eviction because the state is in SQL storage, not memory", async () => {
    await hub("evict").setStatuses([
      update({ monitorId: 3, latencyMs: 55, checkedAt: 2_000 }),
    ]);

    await evictDurableObject(hub("evict"));

    await expect(hub("evict").snapshot()).resolves.toEqual([
      { monitor_id: 3, status: "up", latency_ms: 55, checked_at: 2_000 },
    ]);
  });
});
