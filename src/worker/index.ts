import { Hono } from "hono";
import type { Env } from "./env";

export const app = new Hono<{ Bindings: Env }>().basePath("/api");

app.get("/health", (c) => c.json({ ok: true, env: c.env.APP_ENV }));

app.notFound((c) => c.json({ error: "not_found", message: "Not found" }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal", message: "Something went wrong" }, 500);
});

export default app;
