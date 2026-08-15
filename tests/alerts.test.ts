import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  channelRequest,
  clip,
  humanDuration,
  summarise,
  transitionOf,
  type AlertEvent,
} from "../src/alerts";
import type { Incident, Monitor, NotificationChannel } from "../src/db";
import { createChannel, createIncident, createMonitor, listChannels, updateSettings } from "../src/db";
import worker from "../src/index";

/** A stored row, minus the columns the request shapes never read. */
function channel(patch: Partial<NotificationChannel>): NotificationChannel {
  return {
    id: 1,
    type: "webhook",
    name: "Ops",
    url: null,
    bot_token: null,
    chat_id: null,
    enabled: 1,
    last_sent_at: null,
    last_error: null,
    created_at: 0,
    ...patch,
  };
}

describe("transitionOf", () => {
  it("reports a flip to down and a recovery", () => {
    expect(transitionOf("up", "down")).toBe("down");
    expect(transitionOf("pending", "down")).toBe("down");
    expect(transitionOf("down", "up")).toBe("up");
  });

  it("is silent about a monitor's first successful check", () => {
    // A new monitor coming up is not news — nobody was told it was broken.
    expect(transitionOf("pending", "up")).toBeNull();
  });

  it("is silent when the status has not moved", () => {
    expect(transitionOf("up", "up")).toBeNull();
    expect(transitionOf("down", "down")).toBeNull();
    // Inside the retry window the checker leaves the status alone, so does this.
    expect(transitionOf("up", "up")).toBeNull();
    expect(transitionOf("pending", "pending")).toBeNull();
  });
});

const down: AlertEvent = { monitor: "API", to: "down", message: "HTTP 503" };

describe("summarise", () => {
  it("renders one transition as one line", () => {
    expect(summarise("FlarePulse", [down])).toBe("[FlarePulse] DOWN: API — HTTP 503");
  });

  it("puts a recovery's outage duration on the line", () => {
    expect(summarise("FlarePulse", [{ monitor: "API", to: "up", message: null, downFor: 180 }])).toBe(
      "[FlarePulse] UP: API — down for 3 minutes",
    );
  });

  it("counts several and lists them one per line", () => {
    const text = summarise("FlarePulse", [down, { monitor: "Web", to: "down", message: null }]);

    expect(text).toBe("[FlarePulse] 2 monitors changed state\nDOWN: API — HTTP 503\nDOWN: Web");
  });

  it("uses no emoji, so every client renders it", () => {
    expect(summarise("FlarePulse", [down])).toMatch(/^[\x20-\x7e—]+$/u);
  });
});

describe("channelRequest", () => {
  const message = { site: "FlarePulse", text: "[FlarePulse] DOWN: API — HTTP 503", events: [down] };

  it("posts content to a Discord webhook URL", () => {
    const request = channelRequest(
      channel({ type: "discord", url: "https://discord.com/api/webhooks/1/tok" }),
      message,
    );

    expect(request.url).toBe("https://discord.com/api/webhooks/1/tok");
    expect(request.init.method).toBe("POST");
    expect(request.init.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(request.init.body as string)).toEqual({ content: message.text });
  });

  it("posts chat_id and text to the Telegram bot API", () => {
    const request = channelRequest(
      channel({ type: "telegram", bot_token: "123456:ABC-DEF", chat_id: "-1001" }),
      message,
    );

    expect(request.url).toBe("https://api.telegram.org/bot123456:ABC-DEF/sendMessage");
    expect(JSON.parse(request.init.body as string)).toEqual({
      chat_id: "-1001",
      text: message.text,
    });
  });

  it("posts the structured payload to a generic webhook", () => {
    const request = channelRequest(channel({ url: "https://hooks.test/flarepulse" }), message);

    expect(request.url).toBe("https://hooks.test/flarepulse");
    expect(JSON.parse(request.init.body as string)).toEqual({
      site: "FlarePulse",
      text: message.text,
      events: [down],
    });
  });

  it("clips to each vendor's ceiling", () => {
    const long = { ...message, text: "x".repeat(5_000) };

    const discord = channelRequest(
      channel({ type: "discord", url: "https://discord.com/api/webhooks/1/tok" }),
      long,
    );
    const telegram = channelRequest(
      channel({ type: "telegram", bot_token: "t", chat_id: "1" }),
      long,
    );

    expect(JSON.parse(discord.init.body as string).content).toHaveLength(2_000);
    expect(JSON.parse(telegram.init.body as string).text).toHaveLength(4_096);
    // The generic webhook is FlarePulse's own receiver: no vendor limit to clip to.
    expect(JSON.parse(channelRequest(channel({ url: "https://hooks.test/flarepulse" }), long).init
      .body as string).text).toHaveLength(5_000);
  });

  it("refuses a row the schema should have rejected", () => {
    expect(() => channelRequest(channel({ type: "discord" }), message)).toThrow(/url/i);
  });
});

describe("clip", () => {
  it("leaves short text alone and ellipsises long text", () => {
    expect(clip("short", 10)).toBe("short");
    expect(clip("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("humanDuration", () => {
  it("says what a human would say", () => {
    expect(humanDuration(0)).toBe("less than a minute");
    expect(humanDuration(59)).toBe("less than a minute");
    expect(humanDuration(60)).toBe("1 minute");
    expect(humanDuration(180)).toBe("3 minutes");
    expect(humanDuration(3_600)).toBe("1 hour");
    expect(humanDuration(3_900)).toBe("1 hour 5 minutes");
    expect(humanDuration(7_260)).toBe("2 hours 1 minute");
  });
});

const NOW = 1_700_000_000;

/** Every POST body this tick sent, in order. Probes are GETs and never land here. */
let sent: { host: string; body: Record<string, unknown> }[] = [];

function respond(byHost: Record<string, () => Response | Promise<Response>>) {
  sent = [];
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const reply = byHost[url.host];
    if (!reply) throw new Error(`unexpected fetch to ${url.host}`);
    if (init?.body) sent.push({ host: url.host, body: JSON.parse(String(init.body)) });
    return Promise.resolve(reply());
  });
}

const ok = () => new Response("ok");
const boom = () => new Response("boom", { status: 500 });

function textOf(entry: { body: Record<string, unknown> }): string {
  return String(entry.body.content ?? entry.body.text);
}

async function tick(at = NOW) {
  const ctx = createExecutionContext();
  await worker.scheduled(
    createScheduledController({ scheduledTime: new Date(at * 1_000), cron: "* * * * *" }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
}

async function storedIncidents(): Promise<Incident[]> {
  const { results } = await env.DB.prepare("SELECT * FROM incidents ORDER BY id").all<Incident>();
  return results;
}

const failing = { name: "API", type: "http", target: "https://broken.test/" } as const;
const healthy = { name: "Web", type: "http", target: "https://up.test/" } as const;

const webhookChannel = { type: "webhook", name: "Ops", url: "https://hooks.test/flarepulse" } as const;
const discordChannel = {
  type: "discord",
  name: "Chat",
  url: "https://discord.test/api/webhooks/1/tok",
} as const;

describe("the cron tick's notifications", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM heartbeats"),
      env.DB.prepare("DELETE FROM monitors"),
      env.DB.prepare("DELETE FROM incidents"),
      env.DB.prepare("DELETE FROM notification_channels"),
    ]);
    await updateSettings(
      env.DB,
      { site_name: "FlarePulse", auto_open_incidents: 1, auto_resolve_incidents: 1 },
      NOW,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it("says nothing until the retry window is spent, then once", async () => {
    await createChannel(env.DB, webhookChannel);
    // The default: 2 extra attempts, so the third consecutive failure is the news.
    await createMonitor(env.DB, { ...failing, next_check_at: NOW });
    respond({ "broken.test": boom, "hooks.test": ok });

    await tick(NOW);
    await tick(NOW + 60);
    expect(sent).toEqual([]);
    await expect(storedIncidents()).resolves.toEqual([]);

    await tick(NOW + 120);

    expect(sent.map(textOf)).toEqual(["[FlarePulse] DOWN: API — 500"]);
    await expect(storedIncidents()).resolves.toMatchObject([
      { title: "API is down", auto: 1, status: "investigating", started_at: NOW + 120 },
    ]);
  });

  it("stays quiet while a down monitor keeps failing", async () => {
    await createChannel(env.DB, webhookChannel);
    await createMonitor(env.DB, { ...failing, retries: 0, next_check_at: NOW });
    respond({ "broken.test": boom, "hooks.test": ok });

    await tick(NOW);
    await tick(NOW + 60);
    await tick(NOW + 120);

    expect(sent).toHaveLength(1);
    await expect(storedIncidents()).resolves.toHaveLength(1);
  });

  /** One monitor whose reply this test controls, so it can flap on demand. */
  async function flapper(): Promise<{ monitor: Monitor; up: (value: boolean) => void }> {
    let healthyNow = false;
    const monitor = await createMonitor(env.DB, {
      name: "API",
      type: "http",
      target: "https://flap.test/",
      retries: 0,
      next_check_at: NOW,
    });
    respond({
      "flap.test": () => (healthyNow ? new Response("ok") : new Response("boom", { status: 500 })),
      "hooks.test": ok,
      "discord.test": ok,
    });
    return {
      monitor,
      up: (value: boolean) => {
        healthyNow = value;
      },
    };
  }

  it("resolves its own incident on recovery and says how long it was down", async () => {
    await createChannel(env.DB, webhookChannel);
    const flap = await flapper();

    await tick(NOW);
    flap.up(true);
    await tick(NOW + 180);

    expect(sent.map(textOf)).toEqual([
      "[FlarePulse] DOWN: API — 500",
      "[FlarePulse] UP: API — down for 3 minutes",
    ]);
    await expect(storedIncidents()).resolves.toMatchObject([
      { status: "resolved", resolved_at: NOW + 180, body: "500\n\nRecovered after 3 minutes." },
    ]);
  });

  it("still notifies with auto-open off, and opens nothing", async () => {
    await createChannel(env.DB, webhookChannel);
    await updateSettings(env.DB, { auto_open_incidents: 0 }, NOW);
    await createMonitor(env.DB, { ...failing, retries: 0, next_check_at: NOW });
    respond({ "broken.test": boom, "hooks.test": ok });

    await tick(NOW);

    expect(sent.map(textOf)).toEqual(["[FlarePulse] DOWN: API — 500"]);
    await expect(storedIncidents()).resolves.toEqual([]);
  });

  it("leaves the incident open with auto-resolve off, and still notifies", async () => {
    await createChannel(env.DB, webhookChannel);
    await updateSettings(env.DB, { auto_resolve_incidents: 0 }, NOW);
    const flap = await flapper();

    await tick(NOW);
    flap.up(true);
    await tick(NOW + 180);

    expect(sent.map(textOf)).toEqual([
      "[FlarePulse] DOWN: API — 500",
      "[FlarePulse] UP: API — down for 3 minutes",
    ]);
    await expect(storedIncidents()).resolves.toMatchObject([
      { status: "investigating", resolved_at: null },
    ]);
  });

  it("never closes an incident a human wrote", async () => {
    await updateSettings(env.DB, { auto_open_incidents: 0 }, NOW);
    const flap = await flapper();
    const manual = await createIncident(
      env.DB,
      { monitor_id: flap.monitor.id, title: "Written by hand", status: "identified" },
      NOW,
    );

    await tick(NOW);
    flap.up(true);
    await tick(NOW + 180);

    await expect(storedIncidents()).resolves.toMatchObject([
      { id: manual.id, status: "identified", resolved_at: null, auto: 0 },
    ]);
  });

  it("batches every transition in the tick into one request per channel", async () => {
    await createChannel(env.DB, webhookChannel);
    await createChannel(env.DB, discordChannel);
    await createMonitor(env.DB, { ...failing, retries: 0, next_check_at: NOW });
    await createMonitor(env.DB, { ...healthy, retries: 0, next_check_at: NOW });
    // Both monitors fail in the same tick: two transitions, still two requests.
    respond({ "broken.test": boom, "up.test": boom, "hooks.test": ok, "discord.test": ok });

    await tick(NOW);

    expect(sent.map((entry) => entry.host).sort()).toEqual(["discord.test", "hooks.test"]);
    for (const entry of sent) {
      expect(textOf(entry)).toContain("[FlarePulse] 2 monitors changed state");
      expect(textOf(entry)).toContain("DOWN: API — 500");
      expect(textOf(entry)).toContain("DOWN: Web — 500");
    }
    // The webhook receiver is a program, so it gets the events as data too.
    expect(sent.find((entry) => entry.host === "hooks.test")?.body.events).toMatchObject([
      { monitor: "API", to: "down", message: "500" },
      { monitor: "Web", to: "down", message: "500" },
    ]);
  });

  it("sends nothing to a disabled channel", async () => {
    await createChannel(env.DB, { ...webhookChannel, enabled: false });
    await createMonitor(env.DB, { ...failing, retries: 0, next_check_at: NOW });
    respond({ "broken.test": boom });

    await tick(NOW);

    expect(sent).toEqual([]);
    // The incident is the status page's own record, so it opens regardless.
    await expect(storedIncidents()).resolves.toHaveLength(1);
  });

  it("records a channel's failure, sends the others, and finishes the tick", async () => {
    await createChannel(env.DB, webhookChannel);
    await createChannel(env.DB, discordChannel);
    await createMonitor(env.DB, { ...failing, retries: 0, next_check_at: NOW });
    respond({
      "broken.test": boom,
      "hooks.test": ok,
      "discord.test": () => Promise.reject(new Error("connection refused")),
    });

    await tick(NOW);

    // Both were attempted — the recorded results are what tells them apart.
    expect(sent.map((entry) => entry.host).sort()).toEqual(["discord.test", "hooks.test"]);
    const [ops, chat] = await listChannels(env.DB);
    expect(ops).toMatchObject({ name: "Ops", last_sent_at: NOW, last_error: null });
    expect(chat).toMatchObject({ name: "Chat", last_sent_at: NOW, last_error: "connection refused" });
    // The heartbeat still landed: a broken channel does not fail a tick.
    await expect(storedIncidents()).resolves.toHaveLength(1);
  });

  it("records a rejected delivery by status, then clears it on the next success", async () => {
    await createChannel(env.DB, webhookChannel);
    let accepting = false;
    await createMonitor(env.DB, {
      name: "API",
      type: "http",
      target: "https://flap.test/",
      retries: 0,
      next_check_at: NOW,
    });
    respond({
      "flap.test": () => (accepting ? new Response("ok") : new Response("boom", { status: 500 })),
      "hooks.test": () =>
        accepting ? new Response("ok") : new Response("no", { status: 404 }),
    });

    await tick(NOW);
    await expect(listChannels(env.DB)).resolves.toMatchObject([
      { last_sent_at: NOW, last_error: "HTTP 404" },
    ]);

    accepting = true;
    await tick(NOW + 60);
    await expect(listChannels(env.DB)).resolves.toMatchObject([
      { last_sent_at: NOW + 60, last_error: null },
    ]);
  });

  it("makes no request at all on a tick with no transitions", async () => {
    await createChannel(env.DB, webhookChannel);
    await createMonitor(env.DB, { ...healthy, next_check_at: NOW });
    respond({ "up.test": ok });

    // pending → up is not news, so the only fetch is the probe itself.
    await tick(NOW);

    expect(sent).toEqual([]);
    await expect(storedIncidents()).resolves.toEqual([]);
  });
});
