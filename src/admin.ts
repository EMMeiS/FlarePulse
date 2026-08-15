import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  adminExists,
  adminMonitors,
  channelById,
  createAdmin,
  createChannel,
  createGroup,
  createIncident,
  createMaintenance,
  createMonitor,
  createSession,
  deleteChannel,
  deleteGroup,
  deleteIncident,
  deleteMaintenance,
  deleteMonitor,
  deleteSession,
  getAdmin,
  getSettings,
  listChannels,
  listGroups,
  listMaintenance,
  listMonitors,
  maintenanceById,
  nowSeconds,
  recentHeartbeats,
  recentIncidents,
  sessionAdmin,
  setAdminLock,
  updateChannel,
  updateGroup,
  updateIncident,
  updateMaintenance,
  updateMonitor,
  updateSettings,
} from "./db";
import type { Admin, ChannelType, IncidentPatch, MonitorPatch } from "./db";
import { deliver } from "./alerts";
import { liveSocket } from "./monitor-hub";
import { MIN_INTERVAL_SECONDS, SUBREQUEST_LIMIT, WRITE_LIMIT_PER_DAY } from "./limits";
import {
  hashPassword,
  lockState,
  MIN_PASSWORD_LENGTH,
  newSessionToken,
  SESSION_TTL,
  tokenId,
  verifyPassword,
} from "./auth";

/**
 * The admin API. Two sub-apps mounted at the same prefix: `adminAuth` answers
 * the four requests a signed-out browser is allowed to make, and everything
 * else lives on `adminApi` behind the session gate. Hono stops at the first
 * handler that returns, so mounting auth first is what keeps the gate from
 * swallowing the login route — and means a new admin route is protected by
 * where it is registered rather than by remembering a middleware.
 */
type AdminEnv = { Bindings: Env; Variables: { admin: Admin } };

const COOKIE = "flarepulse_session";

/**
 * `SameSite=Strict` plus a JSON-only mutation surface is this project's whole
 * CSRF answer: a cross-origin form cannot send `content-type: application/json`
 * without a preflight the browser refuses, and the cookie does not ride along
 * on a cross-site request anyway. No token table, no double-submit.
 */
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "Strict",
  path: "/",
} as const;

const setupSchema = z.object({
  username: z.string().trim().min(3).max(32),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
});

/** Login validates presence only: a wrong password deserves 401, not a lecture. */
const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/**
 * Every mutating handler starts here. Returns the parsed body, or the 400 to
 * return as-is — one shape for every validation failure in the admin API.
 */
async function readJson<S extends z.ZodType>(
  c: Context<AdminEnv>,
  schema: S,
): Promise<z.infer<S> | Response> {
  const result = schema.safeParse(await c.req.json().catch(() => null));
  if (result.success) return result.data;

  return c.json(
    {
      error: "validation_failed",
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    },
    400,
  );
}

async function currentAdmin(c: Context<AdminEnv>): Promise<Admin | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  return await sessionAdmin(c.env.DB, await tokenId(token), nowSeconds());
}

async function startSession(c: Context<AdminEnv>, adminId: number, now: number): Promise<void> {
  const token = newSessionToken();
  await createSession(c.env.DB, await tokenId(token), adminId, now, SESSION_TTL);
  setCookie(c, COOKIE, token, { ...COOKIE_OPTIONS, maxAge: SESSION_TTL });
}

export const adminAuth = new Hono<AdminEnv>();

/** What the SPA asks first: setup screen, login screen, or panel. */
adminAuth.get("/session", async (c) => {
  const [exists, admin] = await Promise.all([adminExists(c.env.DB), currentAdmin(c)]);

  return c.json({
    setup_required: !exists,
    authenticated: admin !== null,
    username: admin?.username ?? null,
  });
});

/**
 * The one-time create-admin screen. No default credentials ship anywhere;
 * this route is the only way an account comes into existence, and once one does
 * it is 409 forever — including for the admin who is already signed in, because
 * "create the only account" is not an operation that can happen twice.
 */
adminAuth.post("/setup", async (c) => {
  if (await adminExists(c.env.DB)) return c.json({ error: "setup_closed" }, 409);

  const data = await readJson(c, setupSchema);
  if (data instanceof Response) return data;

  const now = nowSeconds();
  const admin = await createAdmin(c.env.DB, data.username, await hashPassword(data.password), now)
    // Two first visits at once: the primary key is the arbiter, not this handler.
    .catch(() => null);
  if (!admin) return c.json({ error: "setup_closed" }, 409);

  await startSession(c, admin.id, now);
  return c.json({ username: admin.username }, 201);
});

adminAuth.post("/login", async (c) => {
  const data = await readJson(c, loginSchema);
  if (data instanceof Response) return data;

  const now = nowSeconds();
  const admin = await getAdmin(c.env.DB, data.username);
  // An unknown username gets the same answer as a wrong password. No dummy hash
  // to equalise the timing: `GET /api/admin/session` already says publicly
  // whether an account exists, so there is nothing here to hide.
  if (!admin) return c.json({ error: "invalid_credentials" }, 401);

  const lock = lockState(admin, now);
  if (lock.locked) {
    return c.json({ error: "locked", retry_after: (admin.locked_until ?? now) - now }, 423);
  }

  if (!(await verifyPassword(data.password, admin.password_hash))) {
    await setAdminLock(c.env.DB, lock.nextFailure.attempts, lock.nextFailure.lockedUntil);
    return c.json({ error: "invalid_credentials" }, 401);
  }

  if (admin.failed_attempts > 0 || admin.locked_until !== null) {
    await setAdminLock(c.env.DB, 0, null);
  }
  await startSession(c, admin.id, now);
  return c.json({ username: admin.username });
});

/** Server-side revocation, not just a cleared cookie. */
adminAuth.post("/logout", async (c) => {
  const token = getCookie(c, COOKIE);
  if (token) await deleteSession(c.env.DB, await tokenId(token));

  deleteCookie(c, COOKIE, COOKIE_OPTIONS);
  return c.json({ ok: true });
});

export const adminApi = new Hono<AdminEnv>();

adminApi.use("*", async (c, next) => {
  const admin = await currentAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);

  c.set("admin", admin);
  await next();
});

/** The cron floor, shared with the UI copy so the two cannot drift. */
export { MIN_INTERVAL_SECONDS } from "./limits";

/**
 * Only name, type and target are required; every other column's default lives
 * in `createMonitor`, so this schema stays free of defaults and `.partial()`
 * cannot silently reset a field the PATCH body never mentioned.
 */
const monitorSchema = z.object({
  name: z.string().trim().min(1).max(64),
  type: z.enum(["http", "tcp", "dns"]),
  target: z.string().trim().min(1).max(255),
  interval_seconds: z.number().int().min(MIN_INTERVAL_SECONDS).max(86_400).optional(),
  timeout_ms: z.number().int().min(1_000).max(30_000).optional(),
  retries: z.number().int().min(0).max(10).optional(),
  expected_status: z.number().int().min(100).max(599).nullable().optional(),
  keyword: z.string().max(200).nullable().optional(),
  keyword_invert: z.boolean().optional(),
  group_id: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
});

/** SQLite has no booleans, so the boundary is where they become 0 and 1. */
function monitorRow(input: Partial<z.infer<typeof monitorSchema>>): MonitorPatch {
  const { keyword_invert, enabled, ...rest } = input;
  return {
    ...rest,
    ...(keyword_invert === undefined ? {} : { keyword_invert: keyword_invert ? 1 : 0 }),
    ...(enabled === undefined ? {} : { enabled: enabled ? 1 : 0 }),
  };
}

function id(c: Context<AdminEnv>): number {
  return Number(c.req.param("id"));
}

adminApi.get("/monitors", async (c) => c.json(await adminMonitors(c.env.DB)));

adminApi.post("/monitors", async (c) => {
  const data = await readJson(c, monitorSchema);
  if (data instanceof Response) return data;

  return c.json(await createMonitor(c.env.DB, data), 201);
});

adminApi.patch("/monitors/:id", async (c) => {
  const data = await readJson(c, monitorSchema.partial());
  if (data instanceof Response) return data;

  const patch = monitorRow(data);
  // A new interval that only took effect after the old one elapsed would look
  // broken for up to a day. 0 means "due on the next tick".
  if (data.interval_seconds !== undefined) patch.next_check_at = 0;

  const monitor = await updateMonitor(c.env.DB, id(c), patch);
  return monitor ? c.json(monitor) : c.notFound();
});

adminApi.delete("/monitors/:id", async (c) =>
  (await deleteMonitor(c.env.DB, id(c))) ? c.json({ ok: true }) : c.notFound(),
);

/** The live heartbeat view reads history here and takes its updates from `/live`. */
adminApi.get("/monitors/:id/heartbeats", async (c) =>
  c.json(await recentHeartbeats(c.env.DB, id(c))),
);

/**
 * The panel's live feed. On `adminApi`, so the session gate that guards every
 * other admin route guards this one — and unlike the public socket it carries
 * monitors in hidden groups, because an admin can see those anyway.
 */
adminApi.get("/live", (c) => liveSocket(c.env, c.req.raw, "admin"));

const groupSchema = z.object({
  name: z.string().trim().min(1).max(64),
  position: z.number().int().min(0).max(999).optional(),
  is_public: z.boolean().optional(),
});

adminApi.get("/groups", async (c) => c.json(await listGroups(c.env.DB)));

adminApi.post("/groups", async (c) => {
  const data = await readJson(c, groupSchema);
  if (data instanceof Response) return data;

  return c.json(await createGroup(c.env.DB, data), 201);
});

adminApi.patch("/groups/:id", async (c) => {
  const data = await readJson(c, groupSchema.partial());
  if (data instanceof Response) return data;

  const { is_public, ...rest } = data;
  const group = await updateGroup(c.env.DB, id(c), {
    ...rest,
    ...(is_public === undefined ? {} : { is_public: is_public ? 1 : 0 }),
  });
  return group ? c.json(group) : c.notFound();
});

adminApi.delete("/groups/:id", async (c) =>
  (await deleteGroup(c.env.DB, id(c))) ? c.json({ ok: true }) : c.notFound(),
);

/**
 * `resolved_at` is not in the schema: it is derived from `status`, so the form
 * asks for the state once and cannot save a resolved incident that is still
 * open. Reopening clears the timestamp for the same reason.
 */
const incidentSchema = z.object({
  monitor_id: z.number().int().positive().nullable().optional(),
  title: z.string().trim().min(1).max(120),
  body: z.string().max(4_000).nullable().optional(),
  status: z.enum(["investigating", "identified", "monitoring", "resolved"]).optional(),
  started_at: z.number().int().positive().optional(),
});

adminApi.get("/incidents", async (c) => c.json(await recentIncidents(c.env.DB, 50)));

adminApi.post("/incidents", async (c) => {
  const data = await readJson(c, incidentSchema);
  if (data instanceof Response) return data;

  const now = nowSeconds();
  return c.json(
    await createIncident(
      c.env.DB,
      { ...data, resolved_at: data.status === "resolved" ? now : null },
      now,
    ),
    201,
  );
});

adminApi.patch("/incidents/:id", async (c) => {
  const data = await readJson(c, incidentSchema.partial());
  if (data instanceof Response) return data;

  const patch: IncidentPatch = { ...data };
  if (data.status !== undefined) {
    patch.resolved_at = data.status === "resolved" ? nowSeconds() : null;
  }

  const incident = await updateIncident(c.env.DB, id(c), patch);
  return incident ? c.json(incident) : c.notFound();
});

adminApi.delete("/incidents/:id", async (c) =>
  (await deleteIncident(c.env.DB, id(c))) ? c.json({ ok: true }) : c.notFound(),
);

/** A window that ends before it starts would render as a banner that never lifts. */
const ORDERED = { message: "ends_at must be after starts_at", path: ["ends_at"] };

const maintenanceSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().max(4_000).nullable().optional(),
  starts_at: z.number().int().positive(),
  ends_at: z.number().int().positive(),
});

adminApi.get("/maintenance", async (c) => c.json(await listMaintenance(c.env.DB)));

adminApi.post("/maintenance", async (c) => {
  const data = await readJson(
    c,
    maintenanceSchema.refine((window) => window.ends_at > window.starts_at, ORDERED),
  );
  if (data instanceof Response) return data;

  return c.json(await createMaintenance(c.env.DB, data), 201);
});

/**
 * The ordering rule is about the row, not the body, so a patch that moves only
 * one end is checked against the stored other end.
 */
adminApi.patch("/maintenance/:id", async (c) => {
  const data = await readJson(c, maintenanceSchema.partial());
  if (data instanceof Response) return data;

  const current = await maintenanceById(c.env.DB, id(c));
  if (!current) return c.notFound();

  const merged = { ...current, ...data };
  if (merged.ends_at <= merged.starts_at) {
    return c.json(
      { error: "validation_failed", issues: [{ path: "ends_at", message: ORDERED.message }] },
      400,
    );
  }

  const window = await updateMaintenance(c.env.DB, current.id, data);
  return window ? c.json(window) : c.notFound();
});

adminApi.delete("/maintenance/:id", async (c) =>
  (await deleteMaintenance(c.env.DB, id(c))) ? c.json({ ok: true }) : c.notFound(),
);

/** Branding and the two global incident policies. One row, three honoured fields. */
const settingsSchema = z.object({
  site_name: z.string().trim().min(1).max(32).optional(),
  auto_open_incidents: z.boolean().optional(),
  auto_resolve_incidents: z.boolean().optional(),
});

adminApi.get("/settings", async (c) => c.json(await getSettings(c.env.DB)));

adminApi.patch("/settings", async (c) => {
  const data = await readJson(c, settingsSchema);
  if (data instanceof Response) return data;

  const { auto_open_incidents: open, auto_resolve_incidents: resolve, ...rest } = data;
  return c.json(
    await updateSettings(
      c.env.DB,
      {
        ...rest,
        ...(open === undefined ? {} : { auto_open_incidents: open ? 1 : 0 }),
        ...(resolve === undefined ? {} : { auto_resolve_incidents: resolve ? 1 : 0 }),
      },
      nowSeconds(),
    ),
  );
});

/**
 * Only the type and the name are required. Which credentials the type actually
 * needs is decided in one place below, so this schema never has to encode three
 * shapes and the table's `CHECK` can never disagree with the API.
 */
const channelSchema = z.object({
  type: z.enum(["webhook", "discord", "telegram"]),
  name: z.string().trim().min(1).max(64),
  url: z.url().max(500).nullable().optional(),
  bot_token: z.string().trim().min(1).max(200).nullable().optional(),
  chat_id: z.string().trim().min(1).max(64).nullable().optional(),
  enabled: z.boolean().optional(),
});

interface ChannelColumns {
  type: ChannelType;
  name: string;
  url: string | null;
  bot_token: string | null;
  chat_id: string | null;
}

/**
 * The columns one channel type carries, with the ones it does not use nulled —
 * null rather than left alone, so changing a telegram channel into a Discord one
 * cannot leave a stale token behind and trip the schema `CHECK`.
 *
 * `null` back means the configuration is incomplete for its type.
 */
function channelRow(input: {
  type: ChannelType;
  name: string;
  url?: string | null;
  bot_token?: string | null;
  chat_id?: string | null;
}): ChannelColumns | null {
  const { type, name } = input;

  if (type === "telegram") {
    if (!input.bot_token || !input.chat_id) return null;
    return { type, name, url: null, bot_token: input.bot_token, chat_id: input.chat_id };
  }

  if (!input.url) return null;
  return { type, name, url: input.url, bot_token: null, chat_id: null };
}

function incompleteChannel(c: Context<AdminEnv>, type: ChannelType): Response {
  const [path, message] =
    type === "telegram"
      ? ["bot_token", "a telegram channel needs a bot_token and a chat_id"]
      : ["url", `a ${type} channel needs a url`];

  return c.json({ error: "validation_failed", issues: [{ path, message }] }, 400);
}

adminApi.get("/channels", async (c) => c.json(await listChannels(c.env.DB)));

adminApi.post("/channels", async (c) => {
  const data = await readJson(c, channelSchema);
  if (data instanceof Response) return data;

  const columns = channelRow(data);
  if (!columns) return incompleteChannel(c, data.type);

  return c.json(await createChannel(c.env.DB, { ...columns, enabled: data.enabled }), 201);
});

/**
 * Merged into the stored row before it is shaped, like the maintenance ordering
 * rule: a patch that changes only the type is still a complete configuration.
 */
adminApi.patch("/channels/:id", async (c) => {
  const data = await readJson(c, channelSchema.partial());
  if (data instanceof Response) return data;

  const current = await channelById(c.env.DB, id(c));
  if (!current) return c.notFound();

  const merged = { ...current, ...data };
  const columns = channelRow(merged);
  if (!columns) return incompleteChannel(c, merged.type);

  const channel = await updateChannel(c.env.DB, current.id, {
    ...columns,
    ...(data.enabled === undefined ? {} : { enabled: data.enabled ? 1 : 0 }),
  });
  return channel ? c.json(channel) : c.notFound();
});

adminApi.delete("/channels/:id", async (c) =>
  (await deleteChannel(c.env.DB, id(c))) ? c.json({ ok: true }) : c.notFound(),
);

/**
 * The test send is the same request builder and the same delivery path as a real
 * alert — a button with its own code path tests the button. The result is
 * recorded on the row, so the list reports it like any other delivery.
 */
adminApi.post("/channels/:id/test", async (c) => {
  const channel = await channelById(c.env.DB, id(c));
  if (!channel) return c.notFound();

  const { site_name } = await getSettings(c.env.DB);
  const error = await deliver(
    c.env,
    channel,
    {
      site: site_name,
      text: `[${site_name}] Test message. This channel is configured correctly.`,
      events: [],
    },
    nowSeconds(),
  );

  return c.json(error ? { ok: false, error } : { ok: true });
});

/** D1 Free: rows written per day. */
export { SUBREQUEST_LIMIT, WRITE_LIMIT_PER_DAY } from "./limits";

/** One hourly aggregate per monitor per hour, plus one daily row. */
const ROLLUP_ROWS_PER_MONITOR = 25;

export interface QuotaEstimate {
  monitors: number;
  checks_per_minute: number;
  subrequest_limit: number;
  heartbeat_writes_per_day: number;
  rollup_writes_per_day: number;
  writes_per_day: number;
  write_limit: number;
  percent_used: number;
  monitors_at_this_rate: number;
}

/**
 * Steady-state arithmetic, not billing truth — the UI says so and points at the
 * Cloudflare dashboard for the real numbers. It exists because a 60s monitor
 * costs 1,440 rows a day, so the Free plan's write ceiling is ~68 monitors, and
 * the useful time to learn that is before adding the sixty-ninth.
 */
export function quotaEstimate(
  monitors: ReadonlyArray<{ interval_seconds: number; enabled: number }>,
): QuotaEstimate {
  const active = monitors.filter((monitor) => monitor.enabled === 1);
  const checksPerDay = active.reduce(
    (total, monitor) => total + Math.floor(86_400 / monitor.interval_seconds),
    0,
  );
  const rollup = active.length * ROLLUP_ROWS_PER_MONITOR;
  const writes = checksPerDay + rollup;
  const perMonitor = active.length === 0 ? 0 : writes / active.length;

  return {
    monitors: active.length,
    checks_per_minute:
      Math.round(active.reduce((total, m) => total + 600 / m.interval_seconds, 0)) / 10,
    subrequest_limit: SUBREQUEST_LIMIT,
    heartbeat_writes_per_day: checksPerDay,
    rollup_writes_per_day: rollup,
    writes_per_day: writes,
    write_limit: WRITE_LIMIT_PER_DAY,
    percent_used: Math.round((writes * 1_000) / WRITE_LIMIT_PER_DAY) / 10,
    monitors_at_this_rate:
      perMonitor === 0 ? 0 : Math.max(0, Math.floor((WRITE_LIMIT_PER_DAY - writes) / perMonitor)),
  };
}

adminApi.get("/quota", async (c) => c.json(quotaEstimate(await listMonitors(c.env.DB))));
