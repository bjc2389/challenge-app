// M7: security headers on every /api response (SPEC.md §3, §10).
import { expect } from "vitest";
import { API_SECURITY_HEADERS } from "../../src/worker/headers";

/**
 * Literal values from the approved M7 plan. Asserted separately from the constant so
 * that emptying or weakening API_SECURITY_HEADERS can't make the tests pass.
 */
export const EXPECTED_API_SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

/** Asserts every entry of API_SECURITY_HEADERS, plus the literal values above. */
export function expectApiSecurityHeaders(res: Response): void {
  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
    expect(res.headers.get(name), name).toBe(value);
  }
  for (const [name, value] of Object.entries(EXPECTED_API_SECURITY_HEADERS)) {
    expect(res.headers.get(name), name).toBe(value);
  }
}
