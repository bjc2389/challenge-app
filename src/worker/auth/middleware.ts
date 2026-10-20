import type { MiddlewareHandler } from "hono";
import type { AppEnv, Deps } from "../app";
import { apiError } from "../errors";
import { readSession, requireSecret } from "./session";

// The only API routes that work without a session (SPEC.md §3, §10). Matched
// exactly on method and path, so every new route is protected by default.
export const PUBLIC_ROUTES: readonly string[] = [
  "POST /api/login",
  "POST /api/logout",
  "POST /api/admin/login",
  "GET /api/health",
];

const isAdminPath = (path: string) => path === "/api/admin" || path.startsWith("/api/admin/");

export function requireSession(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (PUBLIC_ROUTES.includes(`${c.req.method} ${c.req.path}`)) return next();

    const secret = requireSecret(c.env, "SESSION_SECRET");
    const session = await readSession(c, secret, deps.now());
    if (!session) return apiError(c, 401, "unauthorized", "Log in to continue");
    // An admin session also grants player access.
    if (isAdminPath(c.req.path) && session.role !== "admin") {
      return apiError(c, 403, "forbidden", "Admin access required");
    }
    c.set("session", session);
    return next();
  };
}
