import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createAdmin, listMonitors } from "../src/db";
import { hashPassword } from "../src/auth";
import { quotaEstimate, WRITE_LIMIT_PER_DAY } from "../src/admin";
import type { Incident, MaintenanceWindow, Monitor, NotificationChannel } from "../src/db";
import type { StatusPayload } from "../src/status";

const NOW = Math.floor(Date.now() / 1_000);
const PASSWORD = "correct horse battery";

interface CallOptions {
  body?: unknown;
  cookie?: string;
  method?: string;
}

async function call(path: string, { body, cookie, method }: CallOptions = {}): Promise<Response> {
  const request = new Request(`https://flarepulse.test${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

let cookie = "";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM admins"),
    env.DB.prepare("DELETE FROM heartbeats"),
    env.DB.prepare("DELETE FROM incidents"),
    env.DB.prepare("DELETE FROM maintenance_windows"),
    env.DB.prepare("DELETE FROM monitors"),
    env.DB.prepare("DELETE FROM monitor_groups"),
    env.DB.prepare("DELETE FROM notification_channels"),
    env.DB.prepare(
      `UPDATE settings SET site_name = 'FlarePulse', auto_open_incidents = 1,
       auto_resolve_incidents = 1, updated_at = NULL`,
    ),
  ]);

  await createAdmin(env.DB, "root", await hashPassword(PASSWORD), NOW);
  const response = await call("/api/admin/login", {
    body: { username: "root", password: PASSWORD },
  });
  cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
});

const example = { name: "API", type: "http", target: "https://api.internal.example" };

async function post<T>(path: string, body: unknown, status = 201): Promise<T> {
  const response = await call(path, { body, cookie });
  expect(response.status).toBe(status);
  return (await response.json()) as T;
}

async function patch<T>(path: string, body: unknown, status = 200): Promise<T> {
  const response = await call(path, { body, cookie, method: "PATCH" });
  expect(response.status).toBe(status);
  return (await response.json()) as T;
}

async function get<T>(path: string): Promise<T> {
  const response = await call(path, { cookie });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

async function publicStatus(): Promise<StatusPayload> {
  const response = await call("/api/status");
  expect(response.status).toBe(200);
  return (await response.json()) as StatusPayload;
}

describe("monitor CRUD", () => {
  it("lists full rows, targets included, with the group name", async () => {
    const group = await post<{ id: number }>("/api/admin/groups", { name: "Core" });
    await post("/api/admin/monitors", { ...example, group_id: group.id });

    const monitors = await get<Array<Monitor & { group_name: string | null }>>(
      "/api/admin/monitors",
    );

    expect(monitors).toHaveLength(1);
    expect(monitors[0]).toMatchObject({
      name: "API",
      target: "https://api.internal.example",
      interval_seconds: 60,
      timeout_ms: 10_000,
      retries: 2,
      enabled: 1,
      status: "pending",
      group_name: "Core",
    });
  });

  it("creates one with the settled defaults", async () => {
    const monitor = await post<Monitor>("/api/admin/monitors", example);

    expect(monitor).toMatchObject({
      id: expect.any(Number),
      interval_seconds: 60,
      timeout_ms: 10_000,
      retries: 2,
      keyword_invert: 0,
      enabled: 1,
      next_check_at: 0,
    });
  });

  it("rejects an interval under the cron floor with a usable message", async () => {
    const response = await call("/api/admin/monitors", {
      body: { ...example, interval_seconds: 30 },
      cookie,
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string; issues: Array<{ path: string }> };
    expect(payload.error).toBe("validation_failed");
    expect(payload.issues[0].path).toBe("interval_seconds");
    await expect(listMonitors(env.DB)).resolves.toHaveLength(0);
  });

  it("rejects an unknown type and an empty name", async () => {
    for (const body of [
      { ...example, type: "ping" },
      { ...example, name: "  " },
      { name: "No target", type: "http" },
    ]) {
      expect((await call("/api/admin/monitors", { body, cookie })).status).toBe(400);
    }
  });

  it("patches only the fields in the body", async () => {
    const created = await post<Monitor>("/api/admin/monitors", { ...example, keyword: "ok" });

    const patched = await patch<Monitor>(`/api/admin/monitors/${created.id}`, { name: "API v2" });

    expect(patched).toMatchObject({
      name: "API v2",
      target: example.target,
      keyword: "ok",
      interval_seconds: 60,
    });
  });

  it("makes a new interval take effect on the next tick", async () => {
    const created = await post<Monitor>("/api/admin/monitors", example);
    await env.DB.prepare("UPDATE monitors SET next_check_at = ? WHERE id = ?")
      .bind(NOW + 3_600, created.id)
      .run();

    const patched = await patch<Monitor>(`/api/admin/monitors/${created.id}`, {
      interval_seconds: 300,
    });

    expect(patched.interval_seconds).toBe(300);
    expect(patched.next_check_at).toBe(0);
  });

  it("keeps a disabled monitor but stops checking and publishing it", async () => {
    const created = await post<Monitor>("/api/admin/monitors", example);

    await patch(`/api/admin/monitors/${created.id}`, { enabled: false });

    await expect(listMonitors(env.DB)).resolves.toHaveLength(1);
    expect((await publicStatus()).monitors_total).toBe(0);
    expect((await get<Monitor[]>("/api/admin/monitors"))[0].enabled).toBe(0);
  });

  it("deletes a monitor and its heartbeats", async () => {
    const created = await post<Monitor>("/api/admin/monitors", example);
    await env.DB.prepare(
      "INSERT INTO heartbeats (monitor_id, checked_at, status, latency_ms) VALUES (?, ?, 'up', 12)",
    )
      .bind(created.id, NOW)
      .run();

    const response = await call(`/api/admin/monitors/${created.id}`, {
      method: "DELETE",
      cookie,
    });

    expect(response.status).toBe(200);
    await expect(listMonitors(env.DB)).resolves.toHaveLength(0);
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS n FROM heartbeats").first<{ n: number }>(),
    ).resolves.toEqual({ n: 0 });
  });

  it("is 404 for an unknown id on both patch and delete", async () => {
    expect(
      (await call("/api/admin/monitors/9999", { body: { name: "x" }, cookie, method: "PATCH" }))
        .status,
    ).toBe(404);
    expect((await call("/api/admin/monitors/9999", { method: "DELETE", cookie })).status).toBe(404);
  });

  it("serves the live heartbeat view, newest first", async () => {
    const created = await post<Monitor>("/api/admin/monitors", example);
    await env.DB.batch(
      [NOW - 120, NOW - 60, NOW].map((checkedAt) =>
        env.DB.prepare(
          "INSERT INTO heartbeats (monitor_id, checked_at, status, latency_ms) VALUES (?, ?, 'up', 12)",
        ).bind(created.id, checkedAt),
      ),
    );

    const heartbeats = await get<Array<{ checked_at: number }>>(
      `/api/admin/monitors/${created.id}/heartbeats`,
    );

    expect(heartbeats.map((heartbeat) => heartbeat.checked_at)).toEqual([
      NOW,
      NOW - 60,
      NOW - 120,
    ]);
  });
});

describe("group CRUD", () => {
  it("round-trips a group", async () => {
    const created = await post<{ id: number; name: string; position: number; is_public: number }>(
      "/api/admin/groups",
      { name: "Core", position: 2 },
    );

    expect(created).toMatchObject({ name: "Core", position: 2, is_public: 1 });
    await expect(get("/api/admin/groups")).resolves.toHaveLength(1);

    const patched = await patch<{ name: string }>(`/api/admin/groups/${created.id}`, {
      name: "Core services",
    });
    expect(patched.name).toBe("Core services");

    expect((await call(`/api/admin/groups/${created.id}`, { method: "DELETE", cookie })).status).toBe(
      200,
    );
    await expect(get("/api/admin/groups")).resolves.toHaveLength(0);
  });

  it("leaves the monitors of a deleted group ungrouped", async () => {
    const group = await post<{ id: number }>("/api/admin/groups", { name: "Core" });
    await post("/api/admin/monitors", { ...example, group_id: group.id });

    await call(`/api/admin/groups/${group.id}`, { method: "DELETE", cookie });

    const monitors = await get<Monitor[]>("/api/admin/monitors");
    expect(monitors).toHaveLength(1);
    expect(monitors[0].group_id).toBeNull();
    expect((await publicStatus()).groups[0].name).toBe("Services");
  });

  it("hides a private group from the public page", async () => {
    const group = await post<{ id: number }>("/api/admin/groups", {
      name: "Internal",
      is_public: false,
    });
    await post("/api/admin/monitors", { ...example, group_id: group.id });

    expect((await publicStatus()).groups).toEqual([]);

    await patch(`/api/admin/groups/${group.id}`, { is_public: true });

    expect((await publicStatus()).groups[0].name).toBe("Internal");
  });

  it("is 404 for an unknown group", async () => {
    expect(
      (await call("/api/admin/groups/9999", { body: { name: "x" }, cookie, method: "PATCH" }))
        .status,
    ).toBe(404);
    expect((await call("/api/admin/groups/9999", { method: "DELETE", cookie })).status).toBe(404);
  });
});

describe("incident CRUD", () => {
  it("opens an incident that the public page shows immediately", async () => {
    const created = await post<Incident>("/api/admin/incidents", { title: "Elevated errors" });

    expect(created).toMatchObject({
      title: "Elevated errors",
      status: "investigating",
      monitor_id: null,
      resolved_at: null,
      started_at: expect.any(Number),
    });
    expect((await publicStatus()).incidents[0].title).toBe("Elevated errors");
  });

  it("rejects an unknown status and an empty title", async () => {
    for (const body of [{ title: "x", status: "on fire" }, { title: "  " }, {}]) {
      expect((await call("/api/admin/incidents", { body, cookie })).status).toBe(400);
    }
  });

  it("derives resolved_at from the status, in both directions", async () => {
    const created = await post<Incident>("/api/admin/incidents", { title: "Down" });

    const resolved = await patch<Incident>(`/api/admin/incidents/${created.id}`, {
      status: "resolved",
    });
    expect(resolved.resolved_at).toEqual(expect.any(Number));

    const reopened = await patch<Incident>(`/api/admin/incidents/${created.id}`, {
      status: "investigating",
    });
    expect(reopened.resolved_at).toBeNull();

    const edited = await patch<Incident>(`/api/admin/incidents/${created.id}`, {
      body: "Still looking.",
    });
    expect(edited.status).toBe("investigating");
    expect(edited.resolved_at).toBeNull();
  });

  it("keeps an incident when its monitor is deleted", async () => {
    const monitor = await post<Monitor>("/api/admin/monitors", example);
    const created = await post<Incident>("/api/admin/incidents", {
      title: "API down",
      monitor_id: monitor.id,
    });
    expect(created.monitor_id).toBe(monitor.id);

    await call(`/api/admin/monitors/${monitor.id}`, { method: "DELETE", cookie });

    const incidents = await get<Incident[]>("/api/admin/incidents");
    expect(incidents).toHaveLength(1);
    expect(incidents[0].monitor_id).toBeNull();
  });

  it("deletes one and is 404 for an unknown id", async () => {
    const created = await post<Incident>("/api/admin/incidents", { title: "Typo" });

    expect(
      (await call(`/api/admin/incidents/${created.id}`, { method: "DELETE", cookie })).status,
    ).toBe(200);
    await expect(get("/api/admin/incidents")).resolves.toHaveLength(0);
    expect((await call("/api/admin/incidents/9999", { method: "DELETE", cookie })).status).toBe(404);
    expect(
      (await call("/api/admin/incidents/9999", { body: { title: "x" }, cookie, method: "PATCH" }))
        .status,
    ).toBe(404);
  });
});

describe("maintenance CRUD", () => {
  const window = { title: "Database upgrade", starts_at: NOW + 3_600, ends_at: NOW + 7_200 };

  it("schedules a window the public page picks up", async () => {
    const created = await post<MaintenanceWindow>("/api/admin/maintenance", window);

    expect(created).toMatchObject(window);
    expect((await publicStatus()).maintenance[0].title).toBe("Database upgrade");
  });

  it("refuses a window that ends before it starts, on create and on patch", async () => {
    expect(
      (await call("/api/admin/maintenance", { body: { ...window, ends_at: window.starts_at }, cookie }))
        .status,
    ).toBe(400);

    const created = await post<MaintenanceWindow>("/api/admin/maintenance", window);
    expect(
      (
        await call(`/api/admin/maintenance/${created.id}`, {
          body: { starts_at: created.ends_at + 60 },
          cookie,
          method: "PATCH",
        })
      ).status,
    ).toBe(400);
  });

  it("lists finished windows for the admin but not for the visitor", async () => {
    await post("/api/admin/maintenance", {
      title: "Last night",
      starts_at: NOW - 7_200,
      ends_at: NOW - 3_600,
    });

    await expect(get("/api/admin/maintenance")).resolves.toHaveLength(1);
    expect((await publicStatus()).maintenance).toEqual([]);
  });

  it("patches and deletes", async () => {
    const created = await post<MaintenanceWindow>("/api/admin/maintenance", window);

    const patched = await patch<MaintenanceWindow>(`/api/admin/maintenance/${created.id}`, {
      title: "Database upgrade, take two",
    });
    expect(patched.title).toBe("Database upgrade, take two");
    expect(patched.starts_at).toBe(window.starts_at);

    expect(
      (await call(`/api/admin/maintenance/${created.id}`, { method: "DELETE", cookie })).status,
    ).toBe(200);
    await expect(get("/api/admin/maintenance")).resolves.toHaveLength(0);
    expect((await call("/api/admin/maintenance/9999", { method: "DELETE", cookie })).status).toBe(
      404,
    );
  });
});

describe("quotaEstimate", () => {
  const at = (interval: number, count: number, enabled = 1) =>
    Array.from({ length: count }, () => ({ interval_seconds: interval, enabled }));

  it("counts a day of heartbeats plus the rollup rows they become", () => {
    const estimate = quotaEstimate(at(60, 10));

    // 1,440 checks a day each, plus 24 hourly rows and 1 daily row per monitor.
    expect(estimate.heartbeat_writes_per_day).toBe(14_400);
    expect(estimate.rollup_writes_per_day).toBe(250);
    expect(estimate.writes_per_day).toBe(14_650);
    expect(estimate.write_limit).toBe(WRITE_LIMIT_PER_DAY);
  });

  it("scales with the interval", () => {
    expect(quotaEstimate(at(300, 10)).heartbeat_writes_per_day).toBe(2_880);
  });

  it("reports percent_used to one decimal", () => {
    expect(quotaEstimate(at(60, 10)).percent_used).toBe(14.7);
    expect(quotaEstimate(at(60, 1)).percent_used).toBe(1.5);
  });

  it("compares checks_per_minute against the subrequest ceiling, enabled only", () => {
    expect(quotaEstimate(at(60, 10)).checks_per_minute).toBe(10);
    expect(quotaEstimate(at(300, 10)).checks_per_minute).toBe(2);
    expect(quotaEstimate(at(60, 10)).subrequest_limit).toBe(50);
  });

  it("ignores a disabled monitor entirely", () => {
    const estimate = quotaEstimate([...at(60, 2), ...at(60, 3, 0)]);

    expect(estimate.monitors).toBe(2);
    expect(estimate.checks_per_minute).toBe(2);
    expect(estimate.heartbeat_writes_per_day).toBe(2_880);
  });

  it("says how many more monitors the current average interval leaves room for", () => {
    // 1,465 writes a monitor a day, so 85,350 of headroom is 58 more.
    expect(quotaEstimate(at(60, 10)).monitors_at_this_rate).toBe(58);
    expect(quotaEstimate(at(300, 10)).monitors_at_this_rate).toBeGreaterThan(58);
  });

  it("reports zeros on an empty install instead of dividing by zero", () => {
    expect(quotaEstimate([])).toMatchObject({
      monitors: 0,
      checks_per_minute: 0,
      writes_per_day: 0,
      percent_used: 0,
      monitors_at_this_rate: 0,
    });
  });
});

describe("GET /api/admin/quota", () => {
  it("serves the estimate behind the session gate", async () => {
    await post("/api/admin/monitors", example);

    const quota = await get<{ monitors: number; writes_per_day: number }>("/api/admin/quota");
    expect(quota).toMatchObject({ monitors: 1, writes_per_day: 1_465 });

    expect((await call("/api/admin/quota")).status).toBe(401);
  });
});

describe("settings", () => {
  it("owns the name the public page shows", async () => {
    expect((await publicStatus()).name).toBe("FlarePulse");

    const settings = await patch<{ site_name: string }>("/api/admin/settings", {
      site_name: "Acme Status",
    });

    expect(settings.site_name).toBe("Acme Status");
    await expect(get("/api/admin/settings")).resolves.toMatchObject({ site_name: "Acme Status" });
    expect((await publicStatus()).name).toBe("Acme Status");
  });

  it("rejects an empty or oversized name", async () => {
    for (const site_name of ["", "  ", "x".repeat(33)]) {
      expect(
        (await call("/api/admin/settings", { body: { site_name }, cookie, method: "PATCH" })).status,
      ).toBe(400);
    }

    expect((await publicStatus()).name).toBe("FlarePulse");
  });

  it("takes either incident toggle on its own", async () => {
    await expect(patch("/api/admin/settings", { auto_open_incidents: false })).resolves.toMatchObject(
      { site_name: "FlarePulse", auto_open_incidents: 0, auto_resolve_incidents: 1 },
    );
    await expect(
      patch("/api/admin/settings", { auto_resolve_incidents: false }),
    ).resolves.toMatchObject({ auto_open_incidents: 0, auto_resolve_incidents: 0 });
  });

  it("rejects a toggle that is not a boolean", async () => {
    const response = await call("/api/admin/settings", {
      body: { auto_open_incidents: 1 },
      cookie,
      method: "PATCH",
    });

    expect(response.status).toBe(400);
  });
});

const webhookChannel = { type: "webhook", name: "Ops", url: "https://hooks.test/flarepulse" };
const telegramChannel = {
  type: "telegram",
  name: "Phone",
  bot_token: "123456:ABC-DEF",
  chat_id: "-1001",
};

describe("notification channels", () => {
  it("needs a session", async () => {
    expect((await call("/api/admin/channels")).status).toBe(401);
  });

  it("creates and lists both credential shapes", async () => {
    await post("/api/admin/channels", webhookChannel);
    await post("/api/admin/channels", telegramChannel);

    await expect(get("/api/admin/channels")).resolves.toMatchObject([
      { name: "Ops", url: "https://hooks.test/flarepulse", bot_token: null, enabled: 1 },
      { name: "Phone", url: null, bot_token: "123456:ABC-DEF", chat_id: "-1001" },
    ]);
  });

  it("refuses a configuration the channel type cannot use", async () => {
    for (const body of [
      { type: "webhook", name: "No url" },
      { type: "discord", name: "No url" },
      { type: "telegram", name: "No chat", bot_token: "t" },
      { type: "webhook", name: "Not a url", url: "hooks.test" },
      { type: "carrier-pigeon", name: "Nope", url: "https://hooks.test/flarepulse" },
    ]) {
      expect((await call("/api/admin/channels", { body, cookie })).status).toBe(400);
    }

    await expect(get("/api/admin/channels")).resolves.toEqual([]);
  });

  it("renames, toggles, and re-shapes a channel whose type changed", async () => {
    const channel = await post<NotificationChannel>("/api/admin/channels", telegramChannel);

    await expect(
      patch(`/api/admin/channels/${channel.id}`, { name: "Pager" }),
    ).resolves.toMatchObject({ name: "Pager", bot_token: "123456:ABC-DEF" });

    await expect(
      patch(`/api/admin/channels/${channel.id}`, { enabled: false }),
    ).resolves.toMatchObject({ enabled: 0, name: "Pager" });

    // The stored token and chat id have no meaning for a Discord webhook, and
    // leaving them would trip the table's CHECK.
    await expect(
      patch(`/api/admin/channels/${channel.id}`, {
        type: "discord",
        url: "https://discord.test/api/webhooks/1/tok",
      }),
    ).resolves.toMatchObject({
      type: "discord",
      url: "https://discord.test/api/webhooks/1/tok",
      bot_token: null,
      chat_id: null,
    });
  });

  it("404s a patch or delete for an id that is gone", async () => {
    const channel = await post<NotificationChannel>("/api/admin/channels", webhookChannel);

    expect(
      (await call(`/api/admin/channels/${channel.id}`, { cookie, method: "DELETE" })).status,
    ).toBe(200);
    expect(
      (await call(`/api/admin/channels/${channel.id}`, { cookie, method: "DELETE" })).status,
    ).toBe(404);
    expect(
      (
        await call(`/api/admin/channels/${channel.id}`, {
          body: { name: "ghost" },
          cookie,
          method: "PATCH",
        })
      ).status,
    ).toBe(404);
  });

  it("sends a real request when a channel is tested, and records the result", async () => {
    const channel = await post<NotificationChannel>("/api/admin/channels", webhookChannel);
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

    await expect(post(`/api/admin/channels/${channel.id}/test`, {}, 200)).resolves.toEqual({
      ok: true,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.test/flarepulse");
    expect(JSON.parse(String(init.body)).text).toMatch(/test/i);
    await expect(get("/api/admin/channels")).resolves.toMatchObject([{ last_error: null }]);

    vi.restoreAllMocks();
  });

  it("reports a failed test without failing the request", async () => {
    const channel = await post<NotificationChannel>("/api/admin/channels", webhookChannel);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));

    await expect(post(`/api/admin/channels/${channel.id}/test`, {}, 200)).resolves.toEqual({
      ok: false,
      error: "connection refused",
    });
    vi.restoreAllMocks();

    await expect(get("/api/admin/channels")).resolves.toMatchObject([
      { last_error: "connection refused" },
    ]);
  });

  it("404s a test for a channel that does not exist", async () => {
    expect((await call("/api/admin/channels/999/test", { body: {}, cookie })).status).toBe(404);
  });
});
