import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Read once in Node, hand the SQL to the pool as a test-only binding, and let
// each test file apply it to its own isolated database in setup.
const migrations = await readD1Migrations("./migrations");

// Tests run inside workerd against the real bindings declared in wrangler.jsonc.
// Storage isolation is automatic per test file in this version of the pool.
export default defineConfig({
  // Mirrors the "@/*" path in tsconfig.json so the UI render tests can import
  // the components the way the components import each other.
  resolve: { alias: { "@": "/frontend" } },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    setupFiles: ["./tests/apply-migrations.ts"],
  },
});
