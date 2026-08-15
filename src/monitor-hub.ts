import { DurableObject } from "cloudflare:workers";
import type { CheckStatus, MonitorStatus } from "./db";

export interface StatusUpdate {
  monitorId: number;
  /** The monitor's status, which the retry window can hold still. */
  status: MonitorStatus;
  /** This check on its own — one segment of a heartbeat bar. */
  check: CheckStatus;
  latencyMs: number | null;
  checkedAt: number;
  /** False for a monitor in a group with `is_public = 0`. */
  isPublic: boolean;
}

/** What a dashboard receives. snake_case, like every other payload the frontend reads. */
export interface LiveStatus {
  monitor_id: number;
  status: MonitorStatus;
  check: CheckStatus;
  latency_ms: number | null;
  checked_at: number;
}

export interface LiveFrame {
  type: "status";
  updates: LiveStatus[];
}

/** The tag a socket is accepted with, and the only thing that decides what it hears. */
export type SocketRole = "public" | "admin";

/**
 * `/api/live` is unauthenticated by design — it carries the data the status page
 * already publishes — so a cap is what stands between an open endpoint and a
 * metered resource. Past it a dashboard renders and does not move, which is
 * the graceful degradation rather than an error page.
 */
export const MAX_SOCKETS = 256;

// The index signature is what `sql.exec<T>()` requires of a row type.
export interface StatusRow extends Record<string, SqlStorageValue> {
  monitor_id: number;
  status: MonitorStatus;
  latency_ms: number | null;
  checked_at: number;
}

function wire(update: StatusUpdate): LiveStatus {
  return {
    monitor_id: update.monitorId,
    status: update.status,
    check: update.check,
    latency_ms: update.latencyMs,
    checked_at: update.checkedAt,
  };
}

/**
 * The live view of monitor status. D1 keeps the durable record; this keeps the
 * cheap current one, in its own SQLite storage so it survives eviction, and
 * pushes each tick's results to the dashboards that are watching.
 */
export class MonitorHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS monitor_status (
         monitor_id INTEGER PRIMARY KEY,
         status TEXT NOT NULL,
         latency_ms INTEGER,
         checked_at INTEGER NOT NULL
       )`,
    );
    // The dashboards' keepalive, answered by the runtime without waking this
    // object and without billing its duration.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /**
   * The only reason this object takes an HTTP request: the WebSocket upgrade.
   * The role is in the path because that is what the calling route knows.
   */
  override async fetch(request: Request): Promise<Response> {
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return Response.json({ error: "too_many_connections" }, { status: 503 });
    }

    const role: SocketRole = new URL(request.url).pathname === "/admin" ? "admin" : "public";
    const pair = new WebSocketPair();
    // Hibernation, not `pair[1].accept()`: an idle dashboard should not keep
    // this object in memory, and the tag is what the broadcast filters on.
    this.ctx.acceptWebSocket(pair[1], [role]);

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * Nothing a client sends is acted on — the keepalive is auto-answered and
   * never reaches here. The method exists because an unhandled message faults
   * the object, and that would drop every other dashboard's connection.
   */
  webSocketMessage(): void {}

  /**
   * One call per cron tick, not one per monitor: each RPC call is a billed
   * Durable Object request, and 20 monitors a minute would spend 28,800 of the
   * free plan's 100,000 a day before a single viewer connected.
   */
  setStatuses(updates: StatusUpdate[]): void {
    for (const update of updates) {
      this.ctx.storage.sql.exec(
        `INSERT INTO monitor_status (monitor_id, status, latency_ms, checked_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (monitor_id) DO UPDATE SET
           status = excluded.status,
           latency_ms = excluded.latency_ms,
           checked_at = excluded.checked_at`,
        update.monitorId,
        update.status,
        update.latencyMs,
        update.checkedAt,
      );
    }

    this.broadcast("admin", updates);
    this.broadcast("public", updates.filter((update) => update.isPublic));
  }

  /**
   * One frame per socket per tick. A hidden group is filtered here rather than
   * at the client, so its monitors never reach a public connection at all.
   */
  private broadcast(role: SocketRole, updates: StatusUpdate[]): void {
    if (updates.length === 0) return;

    const sockets = this.ctx.getWebSockets(role);
    if (sockets.length === 0) return;

    const frame = JSON.stringify({ type: "status", updates: updates.map(wire) } satisfies LiveFrame);
    for (const socket of sockets) {
      try {
        socket.send(frame);
      } catch {
        // A socket that died between the check and the send is not the tick's
        // problem, and the tick is what keeps the other viewers current.
      }
    }
  }

  snapshot(): StatusRow[] {
    return this.ctx.storage.sql
      .exec<StatusRow>(
        `SELECT monitor_id, status, latency_ms, checked_at
         FROM monitor_status
         ORDER BY monitor_id`,
      )
      .toArray();
  }
}

/**
 * Everything the two live routes have in common: check the header, hand the
 * request to the one hub. There is a single instance, named `global`, because
 * every dashboard watches every monitor.
 */
export function liveSocket(env: Env, request: Request, role: SocketRole): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return Promise.resolve(Response.json({ error: "upgrade_required" }, { status: 426 }));
  }

  const hub = env.MONITOR_HUB.get(env.MONITOR_HUB.idFromName("global"));
  // The original request, re-addressed: the object's own upgrade handshake needs
  // the `Upgrade` header as much as this route did.
  return hub.fetch(new Request(`https://monitor-hub/${role}`, request));
}
