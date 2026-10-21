// SPEC.md §4 Abandon: allowed from setup, rolled or active; no winner, no end_reason.
// §8 end_reason/winner rules, §6 version, §10 POST /api/games/:code/abandon.
import { beforeEach, describe, expect, it } from "vitest";
import { makeDeps, NOW } from "./helpers/auth";
import { resetDb } from "./helpers/db";
import {
  abandon,
  activeGame,
  anonymous,
  complete,
  createGame,
  eventCount,
  expectApiError,
  gameIn,
  gameRow,
  gameState,
  gameUrl,
  player,
  readView,
  seedRollCatalog,
  teamTaskRows,
  type Api,
  type Status,
} from "./helpers/game";

let ctx: ReturnType<typeof makeDeps>;
let api: Api;

beforeEach(async () => {
  await resetDb();
  await seedRollCatalog();
  ctx = makeDeps();
  api = await player(ctx.deps);
});

describe("§3 §10 POST /api/games/:code/abandon auth and lookup", () => {
  it("401 without a session, and the game is untouched", async () => {
    const { game } = await createGame(api);
    await expectApiError(await anonymous(ctx.deps, "POST", gameUrl(game.code, "/abandon")), 401, "unauthorized");
    expect((await gameRow(game.code)).status).toBe("setup");
  });

  it.each(["ZZZZZ", "ABCD", "ABCD0"])("404 for unknown or malformed code %s", async (code) => {
    await expectApiError(await abandon(api, code), 404, "not_found");
  });
});

describe("§4 abandon from setup, rolled or active", () => {
  it.each<Status>(["setup", "rolled", "active"])(
    "%s: abandoned, ended_at=now, no end_reason, no winner, version +1",
    async (status) => {
      const { code, gameId } = await gameIn(api, status);
      const before = await gameState(gameId);
      ctx.advance(10 * 60_000);
      const now = ctx.deps.now();
      const view = await readView(await abandon(api, code));
      expect(view.version).toBe((before.game?.version ?? -1) + 1);
      expect(view.serverNow).toBe(now);
      expect(view.game).toMatchObject({ status: "abandoned", endedAt: now, endReason: null, winnerTeamId: null });
      expect(await gameRow(code)).toMatchObject({
        status: "abandoned",
        ended_at: now,
        end_reason: null,
        winner_team_id: null,
        version: (before.game?.version ?? -1) + 1,
        created_at: before.game?.created_at,
        rolled_at: before.game?.rolled_at,
        started_at: before.game?.started_at,
        ends_at: before.game?.ends_at,
      });
      // Abandon touches only the games row.
      const after = await gameState(gameId);
      expect({ ...after, game: null }).toEqual({ ...before, game: null });
    },
  );

  it("keeps completions made before abandoning, and writes no event", async () => {
    const g = await activeGame(api);
    await readView(await complete(api, g.code, g.taskIds[0] as number, g.teamIds[0]));
    const tts = await teamTaskRows(g.gameId);
    const view = await readView(await abandon(api, g.code));
    expect(view.teams[0]?.score).toBe(1);
    expect(await teamTaskRows(g.gameId)).toEqual(tts);
    expect(await eventCount(g.gameId)).toBe(1);
  });

  it("ignores the request body", async () => {
    const { game } = await createGame(api);
    const view = await readView(await api.post(gameUrl(game.code, "/abandon"), { winnerTeamId: 1, status: "finished" }));
    expect(view.game).toMatchObject({ status: "abandoned", winnerTeamId: null, endReason: null, endedAt: NOW });
  });

  it("the code is case-insensitive", async () => {
    const { game } = await createGame(api);
    expect((await readView(await abandon(api, game.code.toLowerCase()))).game.status).toBe("abandoned");
  });

  it("at ends_at - 1 an active game is abandoned, not timed out", async () => {
    const g = await activeGame(api);
    ctx.setNow(g.endsAt - 1);
    const view = await readView(await abandon(api, g.code));
    expect(view.game).toMatchObject({ status: "abandoned", endedAt: g.endsAt - 1, endReason: null });
  });
});

describe("§4 abandon after the game is over (409 game_over)", () => {
  it.each<Status>(["finished", "abandoned"])("%s gives 409 game_over with no writes", async (status) => {
    const { code, gameId } = await gameIn(api, status);
    const before = await gameState(gameId);
    ctx.advance(60_000);
    await expectApiError(await abandon(api, code), 409, "game_over");
    expect(await gameState(gameId)).toEqual(before);
  });

  it("an abandoned game rejects every other write with 409 game_over", async () => {
    const g = await activeGame(api);
    await readView(await abandon(api, g.code));
    const before = await gameState(g.gameId);
    await expectApiError(await api.post(gameUrl(g.code, "/start")), 409, "game_over");
    await expectApiError(await api.post(gameUrl(g.code, "/roll")), 409, "game_over");
    await expectApiError(await api.patch(gameUrl(g.code, "/teams"), { team1: "Red", team2: "Blue" }), 409, "game_over");
    await expectApiError(await complete(api, g.code, g.taskIds[0] as number, g.teamIds[0]), 409, "game_over");
    expect(await gameState(g.gameId)).toEqual(before);
  });

  it("an abandoned active game is never finalized by timeout later", async () => {
    const g = await activeGame(api);
    await readView(await abandon(api, g.code));
    const before = await gameState(g.gameId);
    ctx.setNow(g.endsAt + 1);
    const view = await readView(await api.get(gameUrl(g.code)));
    expect(view.game).toMatchObject({ status: "abandoned", endReason: null, winnerTeamId: null });
    expect(await gameState(g.gameId)).toEqual(before);
  });
});
