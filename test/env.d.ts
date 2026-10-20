import type { Env as WorkerEnv } from "../src/worker/env";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
    interface GlobalProps {
      mainModule: typeof import("../src/worker/index");
    }
  }
}
