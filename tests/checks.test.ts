import { afterEach, describe, expect, it, vi } from "vitest";
import type { Monitor } from "../src/db";
import { checkDns, checkHttp, checkTcp, runCheck } from "../src/checks";

function monitor(overrides: Partial<Monitor> = {}): Monitor {
  return {
    id: 1,
    name: "example",
    type: "http",
    target: "https://example.com",
    interval_seconds: 60,
    timeout_ms: 10_000,
    retries: 2,
    expected_status: null,
    keyword: null,
    keyword_invert: 0,
    group_id: null,
    enabled: 1,
    status: "pending",
    fail_streak: 0,
    next_check_at: 0,
    last_checked_at: null,
    created_at: 0,
    ...overrides,
  };
}

function mockFetch(response: Response | Error) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(() =>
      response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
    );
}

afterEach(() => vi.restoreAllMocks());

describe("checkHttp", () => {
  it("reports up with a latency for a 2xx response", async () => {
    mockFetch(new Response("ok"));

    const outcome = await checkHttp(monitor());

    expect(outcome.status).toBe("up");
    expect(outcome.message).toBe("200");
    expect(typeof outcome.latencyMs).toBe("number");
  });

  it("reports down for a 5xx response and names the status", async () => {
    mockFetch(new Response("boom", { status: 500 }));

    await expect(checkHttp(monitor())).resolves.toMatchObject({
      status: "down",
      message: "500",
    });
  });

  it("honours expected_status over the default 2xx rule", async () => {
    mockFetch(new Response(null, { status: 301, headers: { location: "/moved" } }));
    await expect(checkHttp(monitor({ expected_status: 301 }))).resolves.toMatchObject({
      status: "up",
    });

    mockFetch(new Response("ok"));
    await expect(checkHttp(monitor({ expected_status: 301 }))).resolves.toMatchObject({
      status: "down",
      message: "200",
    });
  });

  it("requires the keyword in the body when one is configured", async () => {
    mockFetch(new Response("all systems nominal"));
    await expect(checkHttp(monitor({ keyword: "nominal" }))).resolves.toMatchObject({
      status: "up",
    });

    mockFetch(new Response("all systems nominal"));
    await expect(checkHttp(monitor({ keyword: "degraded" }))).resolves.toMatchObject({
      status: "down",
      message: "keyword not found",
    });
  });

  it("inverts the keyword rule when keyword_invert is set", async () => {
    mockFetch(new Response("fatal error"));
    await expect(
      checkHttp(monitor({ keyword: "error", keyword_invert: 1 })),
    ).resolves.toMatchObject({ status: "down", message: "keyword found" });

    mockFetch(new Response("all good"));
    await expect(
      checkHttp(monitor({ keyword: "error", keyword_invert: 1 })),
    ).resolves.toMatchObject({ status: "up" });
  });

  it("does not read the body when no keyword is configured", async () => {
    const response = new Response("expensive body");
    const bodyRead = vi.spyOn(response, "text");
    mockFetch(response);

    await checkHttp(monitor());

    expect(bodyRead).not.toHaveBeenCalled();
  });

  it("turns a thrown fetch into a down outcome carrying the message", async () => {
    mockFetch(new Error("getaddrinfo ENOTFOUND"));

    await expect(checkHttp(monitor())).resolves.toEqual({
      status: "down",
      latencyMs: null,
      message: "getaddrinfo ENOTFOUND",
    });
  });

  it("passes an abort signal so timeout_ms is enforced", async () => {
    const spy = mockFetch(new Response("ok"));

    await checkHttp(monitor({ timeout_ms: 2_000 }));

    expect(spy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

function dohResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/dns-json" },
  });
}

describe("checkDns", () => {
  it("reports up when the resolver answers with records", async () => {
    mockFetch(dohResponse({ Status: 0, Answer: [{ name: "example.com", type: 1, data: "1.2.3.4" }] }));

    await expect(checkDns(monitor({ type: "dns", target: "example.com" }))).resolves.toMatchObject({
      status: "up",
    });
  });

  it("asks Cloudflare's JSON DoH endpoint for an A record by default", async () => {
    const spy = mockFetch(dohResponse({ Status: 0, Answer: [{ data: "1.2.3.4" }] }));

    await checkDns(monitor({ type: "dns", target: "example.com" }));

    const [url, init] = spy.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://cloudflare-dns.com/dns-query?name=example.com&type=A");
    expect(new Headers(init?.headers).get("accept")).toBe("application/dns-json");
  });

  it("takes the record type from the target suffix", async () => {
    const spy = mockFetch(dohResponse({ Status: 0, Answer: [{ data: "::1" }] }));

    await checkDns(monitor({ type: "dns", target: "example.com/AAAA" }));

    expect(String(spy.mock.calls[0]?.[0])).toContain("name=example.com&type=AAAA");
  });

  it("reports down on a non-zero DNS status", async () => {
    mockFetch(dohResponse({ Status: 3 }));

    await expect(checkDns(monitor({ type: "dns", target: "nope.example" }))).resolves.toMatchObject({
      status: "down",
      message: "DNS status 3",
    });
  });

  it("reports down when the answer section is empty", async () => {
    mockFetch(dohResponse({ Status: 0, Answer: [] }));

    await expect(checkDns(monitor({ type: "dns", target: "example.com" }))).resolves.toMatchObject({
      status: "down",
      message: "no records",
    });
  });

  it("reports down when the resolver itself errors", async () => {
    mockFetch(new Response("nope", { status: 502 }));

    await expect(checkDns(monitor({ type: "dns", target: "example.com" }))).resolves.toMatchObject({
      status: "down",
      message: "resolver 502",
    });
  });
});

function fakeSocket(overrides: { opened?: Promise<unknown>; read?: Promise<unknown> } = {}) {
  const close = vi.fn(() => Promise.resolve());
  return {
    close,
    socket: {
      opened: overrides.opened ?? Promise.resolve({}),
      closed: new Promise(() => {}),
      close,
      // A silent-but-open peer: read never settles, so the grace window decides.
      readable: {
        getReader: () => ({ read: () => overrides.read ?? new Promise(() => {}) }),
      },
    } as unknown as Socket,
  };
}

describe("checkTcp", () => {
  // A silent peer means the grace window decides, and the window is capped by
  // timeout_ms — so these tests keep timeout_ms small to stay fast.
  const silent = (overrides: Partial<Monitor> = {}) =>
    monitor({ type: "tcp", target: "example.com:443", timeout_ms: 60, ...overrides });

  it("reports up when the socket opens, and closes it again", async () => {
    const { socket, close } = fakeSocket();

    const outcome = await checkTcp(silent(), () => socket);

    expect(outcome.status).toBe("up");
    expect(typeof outcome.latencyMs).toBe("number");
    expect(close).toHaveBeenCalled();
  });

  it("reports down when the first read rejects, which is how a dead host shows up", async () => {
    const { socket } = fakeSocket({ read: Promise.reject(new Error("connection reset")) });

    await expect(
      checkTcp(monitor({ type: "tcp", target: "example.com:443" }), () => socket),
    ).resolves.toMatchObject({ status: "down", message: "connection reset" });
  });

  it("reports the handshake time, not the grace window it then waits out", async () => {
    const { socket } = fakeSocket();
    const startedAt = Date.now();

    const outcome = await checkTcp(silent({ timeout_ms: 300 }), () => socket);

    // The call waits out the whole window; the number it reports does not.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
    expect(outcome.latencyMs).toBeLessThan(200);
  });

  it("passes hostname and port through to connect", async () => {
    const { socket } = fakeSocket();
    const connect = vi.fn(() => socket);

    await checkTcp(silent({ target: "db.example.com:5432" }), connect);

    expect(connect).toHaveBeenCalledWith({ hostname: "db.example.com", port: 5432 }, expect.anything());
  });

  it("reports down when the connection is refused", async () => {
    const { socket } = fakeSocket({ opened: Promise.reject(new Error("connection refused")) });

    await expect(
      checkTcp(monitor({ type: "tcp", target: "example.com:9" }), () => socket),
    ).resolves.toMatchObject({ status: "down", message: "connection refused" });
  });

  it("reports down when connect throws outright", async () => {
    await expect(
      checkTcp(monitor({ type: "tcp", target: "example.com:25" }), () => {
        throw new Error("port 25 is blocked");
      }),
    ).resolves.toMatchObject({ status: "down", message: "port 25 is blocked" });
  });

  it("gives up after timeout_ms instead of hanging the tick", async () => {
    const { socket } = fakeSocket({ opened: new Promise(() => {}) });

    await expect(
      checkTcp(monitor({ type: "tcp", target: "example.com:443", timeout_ms: 20 }), () => socket),
    ).resolves.toMatchObject({ status: "down", message: "timed out after 20ms" });
  });

  it("rejects a target without a port rather than guessing one", async () => {
    const connect = vi.fn();

    await expect(
      checkTcp(monitor({ type: "tcp", target: "example.com" }), connect as never),
    ).resolves.toMatchObject({ status: "down", message: "invalid target, expected host:port" });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("runCheck", () => {
  it("dispatches on the monitor type", async () => {
    const spy = mockFetch(new Response("ok"));
    await expect(runCheck(monitor())).resolves.toMatchObject({ status: "up" });
    expect(String(spy.mock.calls[0]?.[0])).toBe("https://example.com");

    mockFetch(dohResponse({ Status: 0, Answer: [{ data: "1.2.3.4" }] }));
    await expect(runCheck(monitor({ type: "dns", target: "example.com" }))).resolves.toMatchObject({
      status: "up",
    });
  });
});
