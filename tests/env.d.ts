import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    // Test-only binding, injected by vitest.config.ts. Kept out of the Worker's
    // own Env so production code cannot reach for it.
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
