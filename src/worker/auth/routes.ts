import { Hono, type Context } from "hono";
import type { AppEnv, Deps } from "../app";
import { apiError } from "../errors";
import { safeEqual } from "./crypto";
import {
  ADMIN_TTL_MS,
  PLAYER_TTL_MS,
  clearSessionCookie,
  requireSecret,
  setSessionCookie,
  type Role,
} from "./session";

export const LOGIN_FAILURE_DELAY_MS = 1000;

const LOGINS = {
  player: { envVar: "PLAYER_PASSWORD", ttlMs: PLAYER_TTL_MS },
  admin: { envVar: "ADMIN_PASSWORD", ttlMs: ADMIN_TTL_MS },
} as const;

async function readPassword(c: Context): Promise<string | null> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const { password } = body as Record<string, unknown>;
  return typeof password === "string" ? password : null;
}

export function authRoutes(deps: Deps) {
  const login = (role: Role) => async (c: Context<AppEnv>) => {
    const { envVar, ttlMs } = LOGINS[role];
    const expected = requireSecret(c.env, envVar);
    const sessionSecret = requireSecret(c.env, "SESSION_SECRET");

    const password = await readPassword(c);
    if (password === null) return apiError(c, 422, "validation", "Send JSON with a password string");

    if (!(await safeEqual(password, expected))) {
      await deps.delay(LOGIN_FAILURE_DELAY_MS);
      return apiError(c, 401, "unauthorized", "Wrong password");
    }
    await setSessionCookie(c, { role, exp: deps.now() + ttlMs }, sessionSecret, ttlMs);
    return c.json({ ok: true, role });
  };

  return new Hono<AppEnv>()
    .post("/login", login("player"))
    .post("/admin/login", login("admin"))
    .post("/logout", (c) => {
      clearSessionCookie(c);
      return c.json({ ok: true });
    })
    .get("/session", (c) => {
      const { role, exp } = c.get("session");
      return c.json({ role, exp });
    });
}
