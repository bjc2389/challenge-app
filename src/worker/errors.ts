import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// Every API error has the shape {error, message} (SPEC.md §10).
export function apiError(c: Context, status: ContentfulStatusCode, error: string, message: string) {
  return c.json({ error, message }, status);
}

// A required Worker secret is unset, empty or too weak. Only the variable name
// is ever logged, never a value.
export class MissingSecretError extends Error {
  constructor(readonly secretName: string) {
    super(`Missing or invalid secret: ${secretName}`);
    this.name = "MissingSecretError";
  }
}

// Unhandled errors return a generic JSON 500 and never leak details to the client.
export const handleError: ErrorHandler = (err, c) => {
  console.error(err instanceof MissingSecretError ? err.message : err);
  return apiError(c, 500, "internal", "Something went wrong");
};

export const handleNotFound: NotFoundHandler = (c) => apiError(c, 404, "not_found", "Not found");
