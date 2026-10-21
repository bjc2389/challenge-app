// History endpoints (SPEC.md §9, §10). Both first finalize games whose time ran out.
import { Hono } from "hono";
import type { AppEnv, Deps } from "../app";
import { finalizeIfExpired, loadSnapshot, sweepExpiredGames } from "../db/games";
import { isHistoryGame, readEvents, readHistoryGames } from "../db/history";
import { apiError } from "../errors";
import { normalizeCode } from "../game/code";
import { isExpired } from "../game/finalize";
import type { Snapshot } from "../game/types";
import { toHistoryDetail, toHistoryList } from "./historyView";

const MAX_ATTEMPTS = 3;

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
      // If finalizing loses a race (a late completion landed first), retry from fresh
      // state rather than report an expired game as still in progress.
      let snap: Snapshot | null = null;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const loaded = await loadSnapshot(db, code);
        if (!loaded) return notFound();
        const current = await finalizeIfExpired(db, loaded, now);
        if (!isExpired(current.game, now)) {
          snap = current;
          break;
        }
      }
      if (!snap) return apiError(c, 409, "busy", "The game changed too quickly. Try again.");
      // Games still in progress aren't history, and test games are hidden.
      if (!(await isHistoryGame(db, code))) return notFound();

      return c.json(toHistoryDetail(snap, await readEvents(db, snap.game.id)));
    });
}
