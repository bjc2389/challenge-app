import { Hono, type ErrorHandler } from "hono";
import type { Env } from "./env";

export const app = new Hono<{ Bindings: Env }>().basePath("/api");

// Unhandled errors return a generic JSON 500 and never leak details to the client.
export const handleError: ErrorHandler = (err, c) => {
  console.error(err);
  return c.json({ error: "internal", message: "Something went wrong" }, 500);
};

app.get("/health", (c) => c.json({ ok: true, env: c.env.APP_ENV }));

app.notFound((c) => c.json({ error: "not_found", message: "Not found" }, 404));

app.onError(handleError);

export default app;
