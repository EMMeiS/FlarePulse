import { connect } from "cloudflare:sockets";
import type { CheckStatus, Monitor } from "./db";

/** What one probe returns. No database, no schedule — that is the checker's job. */
export interface CheckOutcome {
  status: CheckStatus;
  latencyMs: number | null;
  message: string | null;
}

function down(message: string): CheckOutcome {
  return { status: "down", latencyMs: null, message };
}

/** `connect()` takes no abort signal, so timeout_ms has to be raced by hand. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How long a TCP peer may stay silent before the connection counts as open.
 *
 * This is the one tunable knob in the probe, and 2.5 s is an evidence-based
 * guess rather than a measurement: locally, a connection refused by a port
 * nothing listens on took 2,091 ms to surface as an error, and a shorter window
 * would have called it up. The edge may be faster; `docs/DEPLOY.md` has the
 * step that measures it against a known-closed port on a real instance.
 */
const TCP_GRACE_MS = 2_500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A monitor row is broken, not the platform. Report it, do not throw the tick away. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function checkHttp(monitor: Monitor): Promise<CheckOutcome> {
  const startedAt = Date.now();

  try {
    const response = await fetch(monitor.target, {
      // Workers has no HEAD-only fast path worth the lost keyword support.
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(monitor.timeout_ms),
    });
    const latencyMs = Date.now() - startedAt;

    const statusOk =
      monitor.expected_status === null
        ? response.ok
        : response.status === monitor.expected_status;
    if (!statusOk) {
      return { status: "down", latencyMs, message: String(response.status) };
    }

    // Reading the body costs CPU, so only do it when there is a rule about it.
    if (monitor.keyword) {
      const found = (await response.text()).includes(monitor.keyword);
      const wanted = monitor.keyword_invert === 0;
      if (found !== wanted) {
        return {
          status: "down",
          latencyMs,
          message: found ? "keyword found" : "keyword not found",
        };
      }
    }

    return { status: "up", latencyMs, message: String(response.status) };
  } catch (error) {
    return down(errorMessage(error));
  }
}

/**
 * Workers cannot send raw UDP, so DNS checks go through Cloudflare's JSON
 * DNS-over-HTTPS resolver. Target is a hostname, optionally `hostname/TYPE`.
 */
export async function checkDns(monitor: Monitor): Promise<CheckOutcome> {
  const slash = monitor.target.indexOf("/");
  const name = (slash === -1 ? monitor.target : monitor.target.slice(0, slash)).trim();
  const type = (slash === -1 ? "" : monitor.target.slice(slash + 1).trim().toUpperCase()) || "A";
  if (!name) return down("invalid target, expected a hostname");

  const startedAt = Date.now();

  try {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(monitor.timeout_ms) },
    );
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return { status: "down", latencyMs, message: `resolver ${response.status}` };
    }

    const body = (await response.json()) as { Status?: number; Answer?: unknown[] };
    if (body.Status !== 0) {
      return { status: "down", latencyMs, message: `DNS status ${body.Status}` };
    }
    if (!body.Answer?.length) {
      return { status: "down", latencyMs, message: "no records" };
    }

    return { status: "up", latencyMs, message: `${body.Answer.length} record(s)` };
  } catch (error) {
    return down(errorMessage(error));
  }
}

/** Injected so the suite can drive a fake socket and stay offline. */
export type ConnectFn = (address: SocketAddress, options?: SocketOptions) => Socket;

/**
 * A TCP port check is "did the handshake complete" and nothing more. Port 25 and
 * Cloudflare's own address ranges are blocked by the platform on every plan.
 */
export async function checkTcp(
  monitor: Monitor,
  connectFn: ConnectFn = connect,
): Promise<CheckOutcome> {
  const separator = monitor.target.lastIndexOf(":");
  const hostname = monitor.target.slice(0, separator).trim();
  const port = Number(monitor.target.slice(separator + 1));
  if (separator < 1 || !hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return down("invalid target, expected host:port");
  }

  const startedAt = Date.now();
  let socket: Socket | undefined;

  try {
    socket = connectFn({ hostname, port }, { secureTransport: "off", allowHalfOpen: false });
    await withTimeout(socket.opened, monitor.timeout_ms);

    // Latency is taken here, before the grace window below: waiting for silence
    // is this probe's own decision and has nothing to do with the peer's speed.
    const latencyMs = Date.now() - startedAt;

    // `opened` resolves optimistically — the runtime only dials on the first
    // read or write — so an unreachable host looks open until something reads.
    // Most services say nothing after accepting a connection, so silence past
    // the grace window is the success signal and a rejected read is failure.
    const reader = socket.readable.getReader();
    await Promise.race([reader.read(), sleep(Math.min(TCP_GRACE_MS, monitor.timeout_ms))]);

    return { status: "up", latencyMs, message: "connected" };
  } catch (error) {
    return down(errorMessage(error));
  } finally {
    // Closing a socket that never opened rejects; that is not a check failure.
    await socket?.close().catch(() => {});
  }
}

export function runCheck(monitor: Monitor): Promise<CheckOutcome> {
  switch (monitor.type) {
    case "http":
      return checkHttp(monitor);
    case "tcp":
      return checkTcp(monitor);
    case "dns":
      return checkDns(monitor);
  }
}
