// History endpoints (SPEC.md §9, §10). Both first finalize games whose time ran out.
import { Hono } from "hono";
import type { AppEnv, Deps } from "../app";
import { finalizeIfExpired, loadSnapshot, sweepExpiredGames } from "../db/games";
import { isHistoryGame, readEvents, readHistoryGames } from "../db/history";
import { apiError } from "../errors";
import { normalizeCode } from "../game/code";
import { toHistoryDetail, toHistoryList } from "./historyView";

export function historyRoutes(deps: Deps) {
  return new Hono<AppEnv>()
    .get("/history", async (c) => {
      await sweepExpiredGames(c.env.DB, deps.now());
      return c.json(toHistoryList(await readHistoryGames(c.env.DB)));
    })
    .get("/history/:code", async (c) => {
      const notFound = () => apiError(c, 404, "not_found", "Not found");
      const code = normalizeCode(c.req.param("code"));
      if (!code) return notFound();
      const db = c.env.DB;
      const now = deps.now();
      await sweepExpiredGames(db, now);

      // Finalize this game directly too, in case the sweep's limit didn't reach it.
      const loaded = await loadSnapshot(db, code);
      if (!loaded) return notFound();
      const snap = await finalizeIfExpired(db, loaded, now);
      // Games still in progress aren't history, and test games are hidden.
      if (!(await isHistoryGame(db, code))) return notFound();

      return c.json(toHistoryDetail(snap, await readEvents(db, snap.game.id)));
    });
}
