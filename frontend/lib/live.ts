import { useEffect, useRef, useState } from "react";
import type { AdminMonitor, CheckStatus } from "../../src/db";
import type { LiveFrame, LiveStatus } from "../../src/monitor-hub";
import type { StatusMonitor, StatusPayload } from "../../src/status";
import { BAR_LIMIT, overallStatus } from "../../src/status";

export { BAR_LIMIT };

/** What the connection is doing, in the words the UI shows. */
export type LiveState = "connecting" | "live" | "offline";

/**
 * A frame is JSON from the network, so it is checked rather than trusted. The
 * keepalive answer ("pong") and anything unrecognised come back as null.
 */
export function parseFrame(data: unknown): LiveFrame | null {
  if (typeof data !== "string") return null;

  try {
    const frame = JSON.parse(data) as Partial<LiveFrame> | null;
    if (frame?.type !== "status" || !Array.isArray(frame.updates)) return null;
    return { type: "status", updates: frame.updates };
  } catch {
    return null;
  }
}

function byMonitor(updates: LiveStatus[]): Map<number, LiveStatus> {
  return new Map(updates.map((update) => [update.monitor_id, update]));
}

function patchMonitor(monitor: StatusMonitor, update: LiveStatus): StatusMonitor {
  return {
    ...monitor,
    status: update.status,
    latency_ms: update.latency_ms,
    last_checked_at: update.checked_at,
    // The bar shows the check; the dot above it shows the monitor. Inside a
    // retry window those disagree, which is the point of showing both.
    heartbeats: [
      ...monitor.heartbeats,
      { checked_at: update.checked_at, status: update.check, latency_ms: update.latency_ms },
    ].slice(-BAR_LIMIT),
  };
}

/**
 * The public page's state after a frame. Uptime percentages are deliberately
 * left alone: one check cannot move a 24-hour average enough to matter, and a
 * client-side aggregate that disagrees with the server's is worse than a stale
 * one. The overall word and the up count are recomputed, because those are what
 * a visitor reads first.
 */
export function patchStatus(payload: StatusPayload, updates: LiveStatus[]): StatusPayload {
  const pending = byMonitor(updates);
  if (pending.size === 0) return payload;

  const groups = payload.groups.map((group) => ({
    ...group,
    monitors: group.monitors.map((monitor) => {
      const update = pending.get(monitor.id);
      return update ? patchMonitor(monitor, update) : monitor;
    }),
  }));

  const statuses = groups.flatMap((group) => group.monitors.map((monitor) => monitor.status));
  return {
    ...payload,
    groups,
    overall: overallStatus(statuses),
    monitors_up: statuses.filter((status) => status === "up").length,
  };
}

/** The admin list carries no latency column, so it moves the two fields it has. */
export function patchMonitors(monitors: AdminMonitor[], updates: LiveStatus[]): AdminMonitor[] {
  const pending = byMonitor(updates);
  if (!monitors.some((monitor) => pending.has(monitor.id))) return monitors;

  return monitors.map((monitor) => {
    const update = pending.get(monitor.id);
    return update
      ? { ...monitor, status: update.status, last_checked_at: update.checked_at }
      : monitor;
  });
}

/** One segment of the admin panel's heartbeat bar. */
export interface BarSample {
  checked_at: number;
  status: CheckStatus;
  latency_ms: number | null;
  message: string | null;
}

/**
 * The open monitor's bar. A live update has no message — the wire carries no
 * check output, so nothing about a target can leak through a public socket.
 */
export function patchBar(bar: BarSample[], monitorId: number, updates: LiveStatus[]): BarSample[] {
  const update = byMonitor(updates).get(monitorId);
  if (!update) return bar;

  return [
    ...bar,
    {
      checked_at: update.checked_at,
      status: update.check,
      latency_ms: update.latency_ms,
      message: null,
    },
  ].slice(-BAR_LIMIT);
}

const FIRST_RETRY = 1_000;
const MAX_RETRY = 30_000;
// Under any idle timeout a proxy is likely to apply, and answered by the
// runtime without waking the Durable Object.
const KEEPALIVE = 50_000;

interface Handlers {
  onUpdates: (updates: LiveStatus[]) => void;
  /** Called on every reconnect after the first: a gap means frames were missed. */
  onResume: () => void;
}

/**
 * One socket, reconnected with backoff, reported honestly. The handlers live in
 * a ref so a re-render never reopens the connection.
 */
export function useLive(path: string, handlers: Handlers): LiveState {
  const [state, setState] = useState<LiveState>("connecting");
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | null = null;
    let retry = FIRST_RETRY;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let connected = false;

    function open(): void {
      const url = new URL(path, globalThis.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);

      socket.onopen = () => {
        setState("live");
        retry = FIRST_RETRY;
        if (connected) latest.current.onResume();
        connected = true;
        keepalive = setInterval(() => socket?.send("ping"), KEEPALIVE);
      };

      socket.onmessage = (event: MessageEvent) => {
        const frame = parseFrame(event.data);
        if (frame) latest.current.onUpdates(frame.updates);
      };

      // Both paths land here; a socket that errored also closes.
      socket.onclose = () => retryLater();
      socket.onerror = () => retryLater();
    }

    function retryLater(): void {
      clearInterval(keepalive);
      if (stopped) return;

      setState("offline");
      reconnect = setTimeout(open, retry);
      retry = Math.min(retry * 2, MAX_RETRY);
    }

    open();

    return () => {
      stopped = true;
      clearTimeout(reconnect);
      clearInterval(keepalive);
      socket?.close();
    };
  }, [path]);

  return state;
}
