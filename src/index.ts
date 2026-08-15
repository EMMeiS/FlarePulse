import { Hono } from "hono";
import { adminApi, adminAuth } from "./admin";
import { badgeSvg } from "./badge";
import { runDueChecks } from "./checker";
import { deleteExpiredSessions, nowSeconds } from "./db";
import { liveSocket } from "./monitor-hub";
import { rollupAndPrune } from "./rollup";
import { monitorBadge, monitorHistory, statusPayload } from "./status";

// wrangler.jsonc names this class, so it has to be reachable from the entry point.
export { MonitorHub } from "./monitor-hub";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true, name: "FlarePulse" }));

/** The whole public status page, in one request. */
app.get("/api/status", async (c) => {
  const payload = await statusPayload(c.env.DB, nowSeconds(), c.req.query("window"));
  c.header("cache-control", "public, max-age=30");
  return c.json(payload);
});

/**
 * The public live feed: the same data `/api/status` publishes, pushed as each
 * tick produces it. Unauthenticated for the same reason that endpoint is, and
 * monitors in a hidden group never reach it.
 */
app.get("/api/live", (c) => liveSocket(c.env, c.req.raw, "public"));

/** One monitor's chart series for the requested window. */
app.get("/api/status/monitors/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const history = Number.isInteger(id)
    ? await monitorHistory(c.env.DB, id, nowSeconds(), c.req.query("window"))
    : null;
  if (!history) return c.notFound();

  c.header("cache-control", "public, max-age=60");
  return c.json(history);
});

/**
 * The embeddable badge. The extension is part of the parameter so the URL ends
 * in `.svg`, which is what a README's image tag needs; a non-numeric id simply
 * does not match and falls through to the 404 handler.
 */
app.get("/api/badge/:file{[0-9]+\\.svg}", async (c) => {
  const id = Number.parseInt(c.req.param("file"), 10);
  const badge = await monitorBadge(c.env.DB, id, nowSeconds());
  if (!badge) return c.notFound();

  return c.body(badgeSvg(badge.label, badge.value, badge.status), {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
});

// Order matters: the four signed-out routes are registered first, so the
// session gate on `adminApi` never sees them.
app.route("/api/admin", adminAuth);
app.route("/api/admin", adminApi);

app.notFound((c) =>
  c.json({ error: "not_found", path: new URL(c.req.url).pathname }, 404),
);

export default {
  fetch: app.fetch,
  async scheduled(controller, env, _ctx) {
    // `_ctx` goes unused on purpose: every await stays in this chain rather than
    // `ctx.waitUntil`, because a tool that reports an outage after the next tick
    // is not reporting it. The cron invocation has a minute; this uses it.
    // Seconds, because that is the unit the schema stores.
    const now = Math.floor(controller.scheduledTime / 1_000);
    await runDueChecks(env, now);

    // Once an hour, whichever tick lands first inside it — cron fires close to
    // the minute but not exactly on it.
    if (now % 3_600 < 60) {
      await rollupAndPrune(env.DB, now);
      await deleteExpiredSessions(env.DB, now);
    }
  },
} satisfies ExportedHandler<Env>;
