import {
  SELF,
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth";
import { createAdmin, createGroup, createMonitor } from "../src/db";
import worker from "../src/index";
import { MAX_SOCKETS, type LiveFrame } from "../src/monitor-hub";

const NOW = 1_700_000_000;
const PASSWORD = "correct horse battery";

let cookie = "";

/**
 * Through `SELF` rather than `worker.fetch`, because only a dispatched request
 * is a real upgrade: workerd refuses to return a socket to a synthesised one.
 */
async function call(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return await SELF.fetch(`https://flarepulse.test${path}`, { headers });
}

interface Live {
  socket: WebSocket;
  frames: LiveFrame[];
}

/** Opens a real socket through the Worker and collects what the hub pushes to it. */
async function open(path: string, headers: Record<string, string> = {}): Promise<Live> {
  const response = await call(path, { upgrade: "websocket", ...headers });
  expect(response.status).toBe(101);

  const socket = response.webSocket;
  if (!socket) throw new Error(`no socket on the 101 from ${path}`);

  const frames: LiveFrame[] = [];
  socket.accept();
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)) as LiveFrame);
  });
  return { socket, frames };
}

function respondPerHost(byHost: Record<string, Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).host;
    const reply = byHost[host];
    if (!reply) throw new Error(`unexpected fetch to ${host}`);
    return Promise.resolve(reply);
  });
}

async function tick(scheduledTime = NOW): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(
    createScheduledController({ scheduledTime: new Date(scheduledTime * 1_000), cron: "* * * * *" }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  // The send is synchronous inside the object; the client end needs a turn.
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const opened: WebSocket[] = [];

async function live(path: string, headers?: Record<string, string>): Promise<Live> {
  const connection = await open(path, headers);
  opened.push(connection.socket);
  return connection;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM admins"),
    env.DB.prepare("DELETE FROM heartbeats"),
    env.DB.prepare("DELETE FROM monitors"),
    env.DB.prepare("DELETE FROM monitor_groups"),
  ]);

  await createAdmin(env.DB, "root", await hashPassword(PASSWORD), NOW);
  const response = await SELF.fetch("https://flarepulse.test/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "root", password: PASSWORD }),
  });
  cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
});

afterEach(() => {
  // Sockets outlive a test otherwise, and later assertions count frames.
  for (const socket of opened.splice(0)) socket.close();
  vi.restoreAllMocks();
});

describe("the live endpoints", () => {
  it("refuses a request that is not an upgrade", async () => {
    const response = await call("/api/live");

    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toEqual({ error: "upgrade_required" });
  });

  it("refuses the admin socket without a session", async () => {
    const response = await call("/api/admin/live", { upgrade: "websocket" });

    expect(response.status).toBe(401);
  });

  it("accepts an admin socket with a session", async () => {
    const { socket } = await live("/api/admin/live", { cookie });

    expect(socket).toBeDefined();
  });
});

describe("what a tick pushes", () => {
  it("sends one frame per socket carrying every monitor it checked", async () => {
    await createMonitor(env.DB, {
      name: "one",
      type: "http",
      target: "https://up.test/",
      next_check_at: NOW,
    });
    await createMonitor(env.DB, {
      name: "two",
      type: "http",
      target: "https://up.test/",
      next_check_at: NOW,
    });
    const { frames } = await live("/api/live");
    respondPerHost({ "up.test": new Response("ok") });

    await tick();

    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe("status");
    expect(frames[0].updates).toHaveLength(2);
    expect(frames[0].updates[0]).toMatchObject({ status: "up", check: "up", checked_at: NOW });
  });

  it("keeps a hidden group off the public socket and on the admin one", async () => {
    const hidden = await createGroup(env.DB, { name: "internal", is_public: false });
    const secret = await createMonitor(env.DB, {
      name: "secret",
      type: "http",
      target: "https://up.test/",
      group_id: hidden.id,
      next_check_at: NOW,
    });
    const shown = await createMonitor(env.DB, {
      name: "shown",
      type: "http",
      target: "https://up.test/",
      next_check_at: NOW,
    });

    const publicSocket = await live("/api/live");
    const adminSocket = await live("/api/admin/live", { cookie });
    respondPerHost({ "up.test": new Response("ok") });

    await tick();

    expect(publicSocket.frames[0].updates.map((update) => update.monitor_id)).toEqual([shown.id]);
    expect(adminSocket.frames[0].updates.map((update) => update.monitor_id).sort()).toEqual(
      [secret.id, shown.id].sort(),
    );
  });

  it("reports the monitor's status and the check separately inside a retry window", async () => {
    await createMonitor(env.DB, {
      name: "flaky",
      type: "http",
      target: "https://broken.test/",
      next_check_at: NOW,
    });
    const { frames } = await live("/api/live");
    respondPerHost({ "broken.test": new Response("boom", { status: 500 }) });

    await tick();

    expect(frames[0].updates[0]).toMatchObject({ status: "pending", check: "down" });
  });

  it("sends nothing when no monitor was due", async () => {
    await createMonitor(env.DB, {
      name: "later",
      type: "http",
      target: "https://up.test/",
      next_check_at: NOW + 600,
    });
    const { frames } = await live("/api/live");
    respondPerHost({});

    await tick();

    expect(frames).toEqual([]);
  });

  it("sends one frame per tick, not one per monitor per tick", async () => {
    await createMonitor(env.DB, {
      name: "one",
      type: "http",
      target: "https://up.test/",
      next_check_at: NOW,
    });
    const { frames } = await live("/api/live");
    respondPerHost({ "up.test": new Response("ok") });

    await tick();
    await tick(NOW + 60);

    expect(frames).toHaveLength(2);
  });

  it("carries on when one socket is gone", async () => {
    await createMonitor(env.DB, {
      name: "one",
      type: "http",
      target: "https://up.test/",
      next_check_at: NOW,
    });
    const dead = await live("/api/live");
    const alive = await live("/api/live");
    dead.socket.close();
    respondPerHost({ "up.test": new Response("ok") });

    await tick();

    expect(alive.frames).toHaveLength(1);
  });

  it("refuses the upgrade past the socket cap", async () => {
    await Promise.all(Array.from({ length: MAX_SOCKETS }, () => live("/api/live")));

    const response = await call("/api/live", { upgrade: "websocket" });

    expect(response.status).toBe(503);
  });
});
