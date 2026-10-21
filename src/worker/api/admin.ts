// Admin endpoints (SPEC.md §9, §10).
import { Hono, type Context } from "hono";
import type { AppEnv, Deps } from "../app";
import { deleteGame, readAdminGames, readFullCatalog, setTestFlag } from "../db/admin";
import { sweepExpiredGames } from "../db/games";
import { apiError } from "../errors";
import { normalizeCode } from "../game/code";
import { toAdminCatalog, toAdminGame, toAdminGameList } from "./adminView";

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** Exactly `{isTest: boolean}`, nothing else. */
function parseTestFlag(body: unknown): boolean | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  const isTest = (body as Record<string, unknown>).isTest;
  return keys.length === 1 && typeof isTest === "boolean" ? isTest : null;
}

export function adminRoutes(deps: Deps) {
  const notFound = (c: Context) => apiError(c, 404, "not_found", "Not found");

  return (
    new Hono<AppEnv>()
      // The global middleware already requires an admin session here; checking again
      // keeps these routes safe if they're ever mounted elsewhere.
      .use("/admin/*", async (c, next) => {
        if (c.get("session")?.role !== "admin") return apiError(c, 403, "forbidden", "Admin access required");
        return next();
      })
      .get("/admin/games", async (c) => {
        await sweepExpiredGames(c.env.DB, deps.now());
        return c.json(toAdminGameList(await readAdminGames(c.env.DB)));
      })
      .patch("/admin/games/:code", async (c) => {
        const code = normalizeCode(c.req.param("code"));
        if (!code) return notFound(c);
        const isTest = parseTestFlag(await readJson(c));
        if (isTest === null) return apiError(c, 422, "validation", "Send JSON with isTest true or false");
        if (!(await setTestFlag(c.env.DB, code, isTest))) return notFound(c);
        const [game] = await readAdminGames(c.env.DB, code);
        return game ? c.json(toAdminGame(game)) : notFound(c);
      })
      .delete("/admin/games/:code", async (c) => {
        const code = normalizeCode(c.req.param("code"));
        if (!code || !(await deleteGame(c.env.DB, code))) return notFound(c);
        return c.json({ ok: true });
      })
      .get("/admin/catalog", async (c) => c.json(toAdminCatalog(await readFullCatalog(c.env.DB))))
  );
}
