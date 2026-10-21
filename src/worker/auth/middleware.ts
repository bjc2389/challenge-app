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

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Blocks state-changing requests that a browser marks as coming from another
// origin, such as a form on another site posting to /api/logout. Requests with
// neither header (curl, tests) are allowed: browsers always send Origin on a
// cross-origin POST.
export const rejectCrossOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method)) {
    const fetchSite = c.req.header("sec-fetch-site");
    const origin = c.req.header("origin");
    const crossSite = fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none";
    const crossOrigin = origin !== undefined && origin !== new URL(c.req.url).origin;
    if (crossSite || crossOrigin) return apiError(c, 403, "forbidden", "Cross-origin request blocked");
  }
  return next();
};

export function requireSession(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // Hono answers HEAD with the GET handler, so HEAD follows the GET rule.
    const method = c.req.method === "HEAD" ? "GET" : c.req.method;
    if (PUBLIC_ROUTES.includes(`${method} ${c.req.path}`)) return next();

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
