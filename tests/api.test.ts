import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

async function call(path: string): Promise<Response> {
  const request = new Request(`https://flarepulse.test${path}`);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("api", () => {
  it("reports health", async () => {
    const response = await call("/api/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, name: "FlarePulse" });
  });

  it("uses one error shape for unknown api routes", async () => {
    const response = await call("/api/nope");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "not_found",
      path: "/api/nope",
    });
  });
});

describe("bindings", () => {
  it("exposes the D1 and Durable Object bindings the Worker runs on", () => {
    expect(env.DB).toBeDefined();
    expect(env.MONITOR_HUB).toBeDefined();
  });
});
