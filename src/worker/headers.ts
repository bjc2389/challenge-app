// SPEC.md §3: headers on every /api response. Static files get theirs from public/_headers.
import type { MiddlewareHandler } from "hono";

export const API_SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

// Registered first, so it also covers 401/403/404 and the 500 from onError.
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) c.res.headers.set(name, value);
};
