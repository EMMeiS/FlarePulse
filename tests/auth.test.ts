import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  adminExists,
  createAdmin,
  createSession,
  deleteExpiredSessions,
  deleteSession,
  getAdmin,
  getSettings,
  sessionAdmin,
  setAdminLock,
  setAdminPassword,
  updateSettings,
} from "../src/db";
import {
  hashPassword,
  lockState,
  newSessionToken,
  SESSION_TTL,
  tokenId,
  verifyPassword,
} from "../src/auth";

const NOW = Math.floor(Date.now() / 1_000);
const PASSWORD = "correct horse battery";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM admins"),
    env.DB.prepare("UPDATE settings SET site_name = 'FlarePulse'"),
  ]);
});

describe("hashPassword", () => {
  it("records the parameters it used", async () => {
    const stored = await hashPassword(PASSWORD);
    const [scheme, iterations] = stored.split("$");

    expect(scheme).toBe("pbkdf2-sha256");
    expect(Number(iterations)).toBe(15_000);
    expect(stored.split("$")).toHaveLength(4);
  });

  it("salts every hash separately", async () => {
    const [first, second] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);

    expect(first).not.toBe(second);
  });
});

describe("verifyPassword", () => {
  it("accepts the right password and rejects a wrong one", async () => {
    const stored = await hashPassword(PASSWORD);

    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(true);
    await expect(verifyPassword("correct horse batterz", stored)).resolves.toBe(false);
    await expect(verifyPassword("", stored)).resolves.toBe(false);
  });

  it("rejects a malformed stored value instead of throwing", async () => {
    await expect(verifyPassword(PASSWORD, "")).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, "plaintext")).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, "pbkdf2-sha256$abc$salt$hash")).resolves.toBe(false);
  });

  it("uses the iteration count stored in the hash, not the current constant", async () => {
    // A hash written when the constant was lower still has to verify, which is
    // what makes raising the constant a safe change.
    const stored = await hashPassword(PASSWORD, 1_000);

    expect(stored.split("$")[1]).toBe("1000");
    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(true);
  });
});

describe("session tokens", () => {
  it("hands out a fresh token and a stable digest of it", async () => {
    const token = newSessionToken();
    const other = newSessionToken();

    expect(token).not.toBe(other);
    expect(token.length).toBeGreaterThanOrEqual(32);
    await expect(tokenId(token)).resolves.toMatch(/^[0-9a-f]{64}$/);
    await expect(tokenId(token)).resolves.toBe(await tokenId(token));
    expect(await tokenId(token)).not.toBe(await tokenId(other));
  });
});

describe("lockState", () => {
  const admin = { failed_attempts: 0, locked_until: null };

  it("stays unlocked below the threshold", () => {
    expect(lockState({ ...admin, failed_attempts: 4 }, NOW).locked).toBe(false);
  });

  it("locks for fifteen minutes on the fifth failure", () => {
    const state = lockState({ ...admin, failed_attempts: 4 }, NOW);

    expect(state.locked).toBe(false);
    expect(state.nextFailure.attempts).toBe(5);
    expect(state.nextFailure.lockedUntil).toBe(NOW + 900);
  });

  it("reports an unexpired lock and ignores an expired one", () => {
    expect(lockState({ failed_attempts: 5, locked_until: NOW + 60 }, NOW).locked).toBe(true);
    expect(lockState({ failed_attempts: 5, locked_until: NOW - 1 }, NOW).locked).toBe(false);
  });
});

describe("the admins table", () => {
  it("holds exactly one row, by schema", async () => {
    await expect(adminExists(env.DB)).resolves.toBe(false);

    const admin = await createAdmin(env.DB, "root", await hashPassword(PASSWORD), NOW);

    expect(admin.id).toBe(1);
    expect(admin.username).toBe("root");
    await expect(adminExists(env.DB)).resolves.toBe(true);
    await expect(createAdmin(env.DB, "second", "hash", NOW)).rejects.toThrow();
  });

  it("reads back by username and stores lock state and new hashes", async () => {
    await createAdmin(env.DB, "root", await hashPassword(PASSWORD), NOW);

    await expect(getAdmin(env.DB, "nobody")).resolves.toBeNull();
    const admin = await getAdmin(env.DB, "root");
    expect(admin?.failed_attempts).toBe(0);
    expect(admin?.locked_until).toBeNull();

    await setAdminLock(env.DB, 5, NOW + 900);
    expect((await getAdmin(env.DB, "root"))?.locked_until).toBe(NOW + 900);

    await setAdminPassword(env.DB, "renamed", await hashPassword("another long password"));
    const renamed = await getAdmin(env.DB, "renamed");
    expect(renamed).not.toBeNull();
    await expect(verifyPassword("another long password", renamed!.password_hash)).resolves.toBe(
      true,
    );
  });
});

describe("sessions", () => {
  beforeEach(async () => {
    await createAdmin(env.DB, "root", await hashPassword(PASSWORD), NOW);
  });

  it("round-trips a live session and refuses an expired or unknown one", async () => {
    const token = newSessionToken();
    await createSession(env.DB, await tokenId(token), 1, NOW);

    await expect(sessionAdmin(env.DB, await tokenId(token), NOW)).resolves.toMatchObject({
      username: "root",
    });
    await expect(
      sessionAdmin(env.DB, await tokenId(token), NOW + SESSION_TTL + 1),
    ).resolves.toBeNull();
    await expect(sessionAdmin(env.DB, await tokenId("not a token"), NOW)).resolves.toBeNull();
  });

  it("stores the digest of the token, never the token", async () => {
    const token = newSessionToken();
    await createSession(env.DB, await tokenId(token), 1, NOW);

    const { results } = await env.DB.prepare("SELECT id FROM sessions").all<{ id: string }>();
    expect(results[0].id).not.toBe(token);
    expect(results[0].id).toBe(await tokenId(token));
  });

  it("revokes one session and prunes the expired ones", async () => {
    const live = newSessionToken();
    const stale = newSessionToken();
    await createSession(env.DB, await tokenId(live), 1, NOW);
    await createSession(env.DB, await tokenId(stale), 1, NOW - SESSION_TTL - 10);

    await expect(deleteExpiredSessions(env.DB, NOW)).resolves.toBe(1);
    await expect(sessionAdmin(env.DB, await tokenId(live), NOW)).resolves.not.toBeNull();

    await deleteSession(env.DB, await tokenId(live));
    await expect(sessionAdmin(env.DB, await tokenId(live), NOW)).resolves.toBeNull();
  });
});

describe("settings", () => {
  it("is seeded with one row the reads can rely on", async () => {
    await expect(getSettings(env.DB)).resolves.toMatchObject({ id: 1, site_name: "FlarePulse" });

    await updateSettings(env.DB, { site_name: "Acme Status" }, NOW);

    await expect(getSettings(env.DB)).resolves.toMatchObject({
      site_name: "Acme Status",
      updated_at: NOW,
    });
  });
});

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

/** The `name=value` pair on its own, which is what a browser would send back. */
function sessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("no set-cookie header on the response");
  return header.split(";")[0];
}

const credentials = { username: "root", password: PASSWORD };

async function setUp(): Promise<string> {
  const response = await call("/api/admin/setup", { body: credentials });
  expect(response.status).toBe(201);
  return sessionCookie(response);
}

describe("GET /api/admin/session", () => {
  it("asks for setup on a fresh install", async () => {
    const response = await call("/api/admin/session");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      setup_required: true,
      authenticated: false,
      username: null,
    });
  });

  it("reports the signed-in admin once there is one", async () => {
    const cookie = await setUp();

    await expect((await call("/api/admin/session")).json()).resolves.toEqual({
      setup_required: false,
      authenticated: false,
      username: null,
    });
    await expect((await call("/api/admin/session", { cookie })).json()).resolves.toEqual({
      setup_required: false,
      authenticated: true,
      username: "root",
    });
  });
});

describe("POST /api/admin/setup", () => {
  it("creates the admin and signs them in with a hardened cookie", async () => {
    const response = await call("/api/admin/setup", { body: credentials });
    const header = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ username: "root" });
    expect(header).toContain("flarepulse_session=");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
  });

  it("is closed permanently once an admin exists", async () => {
    const cookie = await setUp();

    for (const options of [{ body: credentials }, { body: credentials, cookie }]) {
      const response = await call("/api/admin/setup", options);
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "setup_closed" });
    }
  });

  it("rejects a weak password or a short username", async () => {
    for (const body of [
      { username: "root", password: "short" },
      { username: "ro", password: PASSWORD },
      { username: "root" },
    ]) {
      const response = await call("/api/admin/setup", { body });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "validation_failed" });
    }

    await expect(adminExists(env.DB)).resolves.toBe(false);
  });
});

describe("POST /api/admin/login", () => {
  it("signs in with the right pair", async () => {
    await setUp();

    const response = await call("/api/admin/login", { body: credentials });

    expect(response.status).toBe(200);
    expect(sessionCookie(response)).toMatch(/^flarepulse_session=[0-9a-f]{64}$/);
  });

  it("says the same thing about a wrong password and an unknown user", async () => {
    await setUp();

    for (const body of [
      { username: "root", password: "wrong but long enough" },
      { username: "nobody", password: PASSWORD },
    ]) {
      const response = await call("/api/admin/login", { body });
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "invalid_credentials" });
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("locks the account after five failures, even for the right password", async () => {
    await setUp();
    const wrong = { username: "root", password: "wrong but long enough" };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await call("/api/admin/login", { body: wrong })).status).toBe(401);
    }
    expect((await getAdmin(env.DB, "root"))?.failed_attempts).toBe(5);

    const locked = await call("/api/admin/login", { body: credentials });
    expect(locked.status).toBe(423);
    await expect(locked.json()).resolves.toMatchObject({ error: "locked" });

    // Once the window passes the right password works again and the count resets.
    await setAdminLock(env.DB, 5, NOW - 1);
    expect((await call("/api/admin/login", { body: credentials })).status).toBe(200);
    const admin = await getAdmin(env.DB, "root");
    expect(admin?.failed_attempts).toBe(0);
    expect(admin?.locked_until).toBeNull();
  });
});

describe("POST /api/admin/logout", () => {
  it("revokes the session server-side and clears the cookie", async () => {
    const cookie = await setUp();

    const response = await call("/api/admin/logout", { method: "POST", cookie });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>(),
    ).resolves.toEqual({ n: 0 });
    expect((await call("/api/admin/monitors", { cookie })).status).toBe(401);
  });
});

describe("the session gate", () => {
  it("refuses every admin route without a valid session", async () => {
    const cookie = await setUp();
    await env.DB.prepare("UPDATE sessions SET expires_at = 1").run();

    for (const options of [{}, { cookie: "flarepulse_session=deadbeef" }, { cookie }]) {
      const response = await call("/api/admin/monitors", options);
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    }
  });

  it("lets a live session through", async () => {
    const cookie = await setUp();

    expect((await call("/api/admin/monitors", { cookie })).status).not.toBe(401);
  });
});

describe("the hourly pass", () => {
  it("prunes expired sessions", async () => {
    await setUp();
    await env.DB.prepare(
      "INSERT INTO sessions (id, admin_id, created_at, expires_at) VALUES ('stale', 1, 0, 1)",
    ).run();

    const ctx = createExecutionContext();
    await worker.scheduled(
      // A time inside the first minute of an hour, which is when the pass runs.
      createScheduledController({ scheduledTime: new Date(3_600_000), cron: "* * * * *" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    await expect(
      env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>(),
    ).resolves.toEqual({ n: 1 });
  });
});
