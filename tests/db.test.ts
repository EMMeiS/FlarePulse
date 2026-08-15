import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createChannel,
  createGroup,
  createIncident,
  createMonitor,
  deleteChannel,
  dueMonitors,
  enabledChannels,
  getSettings,
  listChannels,
  listMonitors,
  markChannelDelivery,
  openAutoIncidentFor,
  recentHeartbeats,
  recordCheck,
  resolveIncident,
  updateChannel,
  updateSettings,
} from "../src/db";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM heartbeats"),
    env.DB.prepare("DELETE FROM monitors"),
  ]);
});

const example = { name: "Example", type: "http", target: "https://example.com" } as const;

describe("schema", () => {
  it("is applied before every test file", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();

    expect(results.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "heartbeat_daily",
        "heartbeat_hourly",
        "heartbeats",
        "monitor_groups",
        "monitors",
      ]),
    );
  });
});

describe("createMonitor", () => {
  it("applies the settled defaults", async () => {
    const monitor = await createMonitor(env.DB, example);

    expect(monitor.id).toBeGreaterThan(0);
    expect(monitor.interval_seconds).toBe(60);
    expect(monitor.retries).toBe(2);
    expect(monitor.status).toBe("pending");
    expect(monitor.enabled).toBe(1);
    expect(monitor.next_check_at).toBe(0);
  });

  it("refuses an interval below the 60s cron floor", async () => {
    // Asserting the constraint text so this cannot pass for some other reason.
    await expect(
      createMonitor(env.DB, { ...example, interval_seconds: 30 }),
    ).rejects.toThrow(/constraint/i);
  });

  it("lists what it created", async () => {
    await createMonitor(env.DB, example);
    await createMonitor(env.DB, { ...example, name: "Second" });

    expect((await listMonitors(env.DB)).map((m) => m.name)).toEqual(["Example", "Second"]);
  });
});

describe("dueMonitors", () => {
  it("returns only enabled monitors that are due, oldest first", async () => {
    const later = await createMonitor(env.DB, { ...example, name: "later", next_check_at: 100 });
    const sooner = await createMonitor(env.DB, { ...example, name: "sooner", next_check_at: 50 });
    await createMonitor(env.DB, { ...example, name: "future", next_check_at: 500 });
    await createMonitor(env.DB, {
      ...example,
      name: "disabled",
      next_check_at: 10,
      enabled: false,
    });

    const due = await dueMonitors(env.DB, 200);

    expect(due.map((m) => m.id)).toEqual([sooner.id, later.id]);
  });

  it("honours its limit", async () => {
    await createMonitor(env.DB, { ...example, name: "a", next_check_at: 1 });
    await createMonitor(env.DB, { ...example, name: "b", next_check_at: 2 });

    expect(await dueMonitors(env.DB, 100, 1)).toHaveLength(1);
  });

  /** The realtime push filters on this flag, so the cron query carries it. */
  it("reports whether each monitor is publicly visible", async () => {
    const shown = await createGroup(env.DB, { name: "shown" });
    const hidden = await createGroup(env.DB, { name: "hidden", is_public: false });

    const ungrouped = await createMonitor(env.DB, { ...example, name: "ungrouped" });
    const inShown = await createMonitor(env.DB, {
      ...example,
      name: "in-shown",
      group_id: shown.id,
    });
    const inHidden = await createMonitor(env.DB, {
      ...example,
      name: "in-hidden",
      group_id: hidden.id,
    });

    const due = await dueMonitors(env.DB, 100);
    const publicById = new Map(due.map((m) => [m.id, m.is_public]));

    expect(publicById.get(ungrouped.id)).toBe(1);
    expect(publicById.get(inShown.id)).toBe(1);
    expect(publicById.get(inHidden.id)).toBe(0);
  });
});

describe("recordCheck", () => {
  it("writes a heartbeat and advances the monitor in one batch", async () => {
    const monitor = await createMonitor(env.DB, example);

    await recordCheck(env.DB, {
      monitorId: monitor.id,
      status: "down",
      latencyMs: 812,
      message: "HTTP 503",
      checkedAt: 1_000,
      monitorStatus: "pending",
      failStreak: 1,
      nextCheckAt: 1_060,
    });

    const [updated] = await listMonitors(env.DB);
    expect(updated).toMatchObject({
      status: "pending",
      fail_streak: 1,
      next_check_at: 1_060,
      last_checked_at: 1_000,
    });

    const beats = await recentHeartbeats(env.DB, monitor.id);
    expect(beats).toHaveLength(1);
    expect(beats[0]).toMatchObject({ status: "down", latency_ms: 812, message: "HTTP 503" });
  });

  it("returns heartbeats newest first, up to the limit", async () => {
    const monitor = await createMonitor(env.DB, example);

    for (const checkedAt of [1_000, 1_060, 1_120]) {
      await recordCheck(env.DB, {
        monitorId: monitor.id,
        status: "up",
        latencyMs: 30,
        message: null,
        checkedAt,
        monitorStatus: "up",
        failStreak: 0,
        nextCheckAt: checkedAt + 60,
      });
    }

    const beats = await recentHeartbeats(env.DB, monitor.id, 2);
    expect(beats.map((b) => b.checked_at)).toEqual([1_120, 1_060]);
  });
});

const webhook = { type: "webhook", name: "Ops", url: "https://hooks.test/flarepulse" } as const;
const telegram = {
  type: "telegram",
  name: "Phone",
  bot_token: "123456:ABC-DEF",
  chat_id: "-1001",
} as const;

describe("notification channels", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM notification_channels").run();
  });

  it("round-trips a webhook channel with the settled defaults", async () => {
    const channel = await createChannel(env.DB, webhook);

    expect(channel).toMatchObject({
      type: "webhook",
      name: "Ops",
      url: "https://hooks.test/flarepulse",
      bot_token: null,
      chat_id: null,
      enabled: 1,
      last_sent_at: null,
      last_error: null,
    });
    expect(await listChannels(env.DB)).toHaveLength(1);
  });

  it("stores a telegram channel's token and chat id", async () => {
    const channel = await createChannel(env.DB, telegram);

    expect(channel).toMatchObject({ bot_token: "123456:ABC-DEF", chat_id: "-1001", url: null });
  });

  it("refuses a webhook with no url and a telegram channel with no chat id", async () => {
    await expect(createChannel(env.DB, { type: "webhook", name: "Bad" })).rejects.toThrow(
      /constraint/i,
    );
    await expect(
      createChannel(env.DB, { type: "telegram", name: "Bad", bot_token: "t" }),
    ).rejects.toThrow(/constraint/i);
  });

  it("lists only the enabled channels for a dispatch", async () => {
    await createChannel(env.DB, webhook);
    await createChannel(env.DB, { ...telegram, enabled: false });

    expect((await enabledChannels(env.DB)).map((c) => c.name)).toEqual(["Ops"]);
  });

  it("patches from the allowlist and reports an unknown id as null", async () => {
    const channel = await createChannel(env.DB, webhook);

    const renamed = await updateChannel(env.DB, channel.id, { name: "Alerts", enabled: 0 });
    expect(renamed).toMatchObject({ name: "Alerts", enabled: 0, url: "https://hooks.test/flarepulse" });

    expect(await updateChannel(env.DB, channel.id + 99, { name: "ghost" })).toBeNull();
  });

  it("records a delivery result and clears the previous error", async () => {
    const channel = await createChannel(env.DB, webhook);

    await markChannelDelivery(env.DB, channel.id, 1_000, "HTTP 404");
    expect(await listChannels(env.DB)).toMatchObject([
      { last_sent_at: 1_000, last_error: "HTTP 404" },
    ]);

    await markChannelDelivery(env.DB, channel.id, 2_000, null);
    expect(await listChannels(env.DB)).toMatchObject([{ last_sent_at: 2_000, last_error: null }]);
  });

  it("reports whether it deleted", async () => {
    const channel = await createChannel(env.DB, webhook);

    await expect(deleteChannel(env.DB, channel.id)).resolves.toBe(true);
    await expect(deleteChannel(env.DB, channel.id)).resolves.toBe(false);
  });
});

describe("settings", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `UPDATE settings
       SET site_name = 'FlarePulse', auto_open_incidents = 1, auto_resolve_incidents = 1,
           updated_at = NULL
       WHERE id = 1`,
    ).run();
  });

  it("defaults both incident toggles to on", async () => {
    expect(await getSettings(env.DB)).toMatchObject({
      site_name: "FlarePulse",
      auto_open_incidents: 1,
      auto_resolve_incidents: 1,
    });
  });

  it("patches one field without touching the others", async () => {
    await updateSettings(env.DB, { site_name: "Acme" }, 1_000);
    await updateSettings(env.DB, { auto_resolve_incidents: 0 }, 2_000);

    expect(await getSettings(env.DB)).toMatchObject({
      site_name: "Acme",
      auto_open_incidents: 1,
      auto_resolve_incidents: 0,
      updated_at: 2_000,
    });
  });
});

describe("auto incidents", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM incidents").run();
  });

  it("finds the open machine-opened incident for a monitor", async () => {
    const monitor = await createMonitor(env.DB, example);
    const opened = await createIncident(
      env.DB,
      { monitor_id: monitor.id, title: "Example is down", auto: 1 },
      1_000,
    );

    expect(await openAutoIncidentFor(env.DB, monitor.id)).toMatchObject({ id: opened.id, auto: 1 });
  });

  it("ignores a manual incident, a resolved one, and another monitor's", async () => {
    const monitor = await createMonitor(env.DB, example);
    const other = await createMonitor(env.DB, { ...example, name: "Other" });

    await createIncident(env.DB, { monitor_id: monitor.id, title: "Written by hand" }, 1_000);
    await createIncident(
      env.DB,
      { monitor_id: monitor.id, title: "Already closed", auto: 1, status: "resolved" },
      900,
    );
    await createIncident(env.DB, { monitor_id: other.id, title: "Other is down", auto: 1 }, 1_000);

    expect(await openAutoIncidentFor(env.DB, monitor.id)).toBeNull();
  });

  it("resolves an incident, appending to the body it already had", async () => {
    const monitor = await createMonitor(env.DB, example);
    const opened = await createIncident(
      env.DB,
      { monitor_id: monitor.id, title: "Example is down", body: "HTTP 503", auto: 1 },
      1_000,
    );

    const resolved = await resolveIncident(env.DB, opened.id, "Recovered after 3 minutes.", 1_180);

    expect(resolved).toMatchObject({
      status: "resolved",
      resolved_at: 1_180,
      body: "HTTP 503\n\nRecovered after 3 minutes.",
    });
  });
});
