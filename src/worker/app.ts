import { Hono } from "hono";
import type { Env } from "./env";
import { rejectCrossOrigin, requireSession } from "./auth/middleware";
import { LOGIN_FAILURE_DELAY_MS, authRoutes } from "./auth/routes";
import type { Session } from "./auth/session";
import { handleError, handleNotFound } from "./errors";

export { LOGIN_FAILURE_DELAY_MS };

export type AppEnv = { Bindings: Env; Variables: { session: Session } };

// Time is injected so tests control the clock and the failed-login delay.
export type Deps = { now(): number; delay(ms: number): Promise<void> };

export const defaultDeps: Deps = {
  now: () => Date.now(),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function createApp(deps: Deps = defaultDeps) {
  const app = new Hono<AppEnv>().basePath("/api");

  app.use("*", rejectCrossOrigin);
  app.use("*", requireSession(deps));
  app.get("/health", (c) => c.json({ ok: true, env: c.env.APP_ENV }));
  app.route("/", authRoutes(deps));

  app.notFound(handleNotFound);
  app.onError(handleError);
  return app;
}
