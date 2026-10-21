import type { Env as WorkerEnv } from "../src/worker/env";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      // Test-only binding from vitest.config.ts.
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import("../src/worker/index");
    }
  }
}
