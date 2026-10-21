import { Hono } from "hono";
import { adminRoutes } from "./api/admin";
import { gameRoutes } from "./api/games";
import { historyRoutes } from "./api/history";
import type { Env } from "./env";
import { rejectCrossOrigin, requireSession } from "./auth/middleware";
import { LOGIN_FAILURE_DELAY_MS, authRoutes } from "./auth/routes";
import type { Session } from "./auth/session";
import { handleError, handleNotFound } from "./errors";
import type { RandomInt } from "./game/types";
import { cryptoRandomInt } from "./random";

export { LOGIN_FAILURE_DELAY_MS };

export type AppEnv = { Bindings: Env; Variables: { session: Session } };

// Time and randomness are injected so tests control the clock, the failed-login
// delay, game codes and rolls.
export type Deps = { now(): number; delay(ms: number): Promise<void>; randomInt: RandomInt };

export const defaultDeps: Deps = {
  now: () => Date.now(),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  randomInt: cryptoRandomInt,
};

export function createApp(deps: Deps = defaultDeps) {
  const app = new Hono<AppEnv>().basePath("/api");

  app.use("*", rejectCrossOrigin);
  app.use("*", requireSession(deps));
  app.get("/health", (c) => c.json({ ok: true, env: c.env.APP_ENV }));
  app.route("/", authRoutes(deps));
  app.route("/", gameRoutes(deps));
  app.route("/", historyRoutes(deps));
  app.route("/", adminRoutes(deps));

  app.notFound(handleNotFound);
  app.onError(handleError);
  return app;
}
