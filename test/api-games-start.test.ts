// SPEC.md §4 Rolled → Active: Start sets started_at and ends_at = start + 60 minutes.
// §6 version, §10 POST /api/games/:code/start.
import { beforeEach, describe, expect, it } from "vitest";
import { makeDeps, NOW } from "./helpers/auth";
import { resetDb } from "./helpers/db";
import {
  DURATION_MS,
  activeGame,
  anonymous,
  createGame,
  eventCount,
  expectApiError,
  gameIn,
  gameRow,
  gameState,
  gameUrl,
  player,
  readView,
  rolledGame,
  seedRollCatalog,
  type Api,
} from "./helpers/game";

let ctx: ReturnType<typeof makeDeps>;
let api: Api;

beforeEach(async () => {
  await resetDb();
  await seedRollCatalog();
  ctx = makeDeps();
  api = await player(ctx.deps);
});

const start = (code: string) => api.post(gameUrl(code, "/start"));

describe("§3 §10 POST /api/games/:code/start auth and lookup", () => {
  it("401 without a session, and the game stays rolled", async () => {
    const g = await rolledGame(api);
    await expectApiError(await anonymous(ctx.deps, "POST", gameUrl(g.code, "/start")), 401, "unauthorized");
    expect((await gameRow(g.code)).status).toBe("rolled");
  });

  it.each(["ZZZZZ", "ABCD", "ABCD0"])("404 for unknown or malformed code %s", async (code) => {
    await expectApiError(await start(code), 404, "not_found");
  });
});

describe("§4 start a rolled game", () => {
  it("sets active, started_at=now, ends_at=now+60min, version +1", async () => {
    const g = await rolledGame(api);
    const v0 = (await gameRow(g.code)).version;
    ctx.setNow(NOW + 5 * 60_000);
    const view = await readView(await start(g.code));
    expect(view.version).toBe(v0 + 1);
    expect(view.serverNow).toBe(NOW + 5 * 60_000);
    expect(view.game).toMatchObject({
      status: "active",
      startedAt: NOW + 5 * 60_000,
      endsAt: NOW + 5 * 60_000 + DURATION_MS,
      endedAt: null,
      endReason: null,
      winnerTeamId: null,
      durationMs: DURATION_MS,
    });
    expect(view.tasks).toEqual(g.view.tasks);
    expect(await gameRow(g.code)).toMatchObject({
      status: "active",
      started_at: NOW + 5 * 60_000,
      ends_at: NOW + 5 * 60_000 + DURATION_MS,
      version: v0 + 1,
    });
    expect(await eventCount(g.gameId)).toBe(0);
  });

  it("the code is case-insensitive", async () => {
    const g = await rolledGame(api);
    expect((await readView(await start(g.code.toLowerCase()))).game.status).toBe("active");
  });
});

describe("§4 start is allowed only when rolled (409)", () => {
  it("setup gives 409 invalid_state with no writes", async () => {
    const { game } = await createGame(api);
    const gameId = (await gameRow(game.code)).id;
    const before = await gameState(gameId);
    await expectApiError(await start(game.code), 409, "invalid_state");
    expect(await gameState(gameId)).toEqual(before);
  });

  it("starting twice gives 409 invalid_state and keeps the original times", async () => {
    const g = await activeGame(api);
    const before = await gameState(g.gameId);
    ctx.advance(60_000);
    await expectApiError(await start(g.code), 409, "invalid_state");
    expect(await gameState(g.gameId)).toEqual(before);
  });

  it.each(["finished", "abandoned"] as const)("%s gives 409 game_over with no writes", async (status) => {
    const { code, gameId } = await gameIn(api, status);
    const before = await gameState(gameId);
    await expectApiError(await start(code), 409, "game_over");
    expect(await gameState(gameId)).toEqual(before);
  });

  it("an expired active game is finalized first (version +1), then 409 game_over", async () => {
    const g = await activeGame(api);
    const v0 = (await gameRow(g.code)).version;
    ctx.setNow(g.endsAt + 1);
    await expectApiError(await start(g.code), 409, "game_over");
    expect(await gameRow(g.code)).toMatchObject({
      status: "finished",
      end_reason: "timeout",
      ended_at: g.endsAt,
      started_at: g.startedAt,
      version: v0 + 1,
    });
  });
});
