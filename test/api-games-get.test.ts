// SPEC.md §4 (join by code, timeout finalize on any request), §6 (serverNow, version),
// §10 GET /api/games/:code.
import { beforeEach, describe, expect, it } from "vitest";
import { makeDeps, NOW } from "./helpers/auth";
import { resetDb } from "./helpers/db";
import {
  DURATION_MS,
  ROLL_CATEGORIES,
  TASKS_PER_GAME,
  abandon,
  activeGame,
  anonymous,
  complete,
  completeAllNonFinal,
  createGame,
  eventCount,
  expectApiError,
  gameIn,
  gameRow,
  gameState,
  gameUrl,
  player,
  readView,
  rollGame,
  seedRollCatalog,
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

describe("§3 §10 GET /api/games/:code auth and lookup", () => {
  it("401 without a session", async () => {
    const { game } = await createGame(api);
    await expectApiError(await anonymous(ctx.deps, "GET", gameUrl(game.code)), 401, "unauthorized");
  });

  it("404 for an unknown, well-formed code", async () => {
    await createGame(api);
    await expectApiError(await api.get(gameUrl("ZZZZZ")), 404, "not_found");
  });

  it.each(["ABCD", "ABCDEF", "ABCD0", "ABCDI", "AB-DE", "%20%20%20%20%20"])("404 for malformed code %s", async (code) => {
    await expectApiError(await api.get(gameUrl(code)), 404, "not_found");
  });

  it("the code is case-insensitive", async () => {
    const created = await createGame(api);
    const view = await readView(await api.get(gameUrl(created.game.code.toLowerCase())));
    expect(view.game.code).toBe(created.game.code);
    expect(view).toEqual(created);
  });
});

describe("§6 GET never bumps the version", () => {
  it("repeated GETs return the same version and the DB version is unchanged", async () => {
    const { game } = await createGame(api);
    for (let i = 0; i < 3; i++) {
      ctx.advance(1000);
      const view = await readView(await api.get(gameUrl(game.code)));
      expect(view.version).toBe(0);
      expect(view.serverNow).toBe(NOW + (i + 1) * 1000);
    }
    expect((await gameRow(game.code)).version).toBe(0);
  });

  it("an active game before ends_at is not touched by GET", async () => {
    const g = await activeGame(api);
    const before = await gameState(g.gameId);
    ctx.setNow(g.endsAt - 1);
    const view = await readView(await api.get(gameUrl(g.code)));
    expect(view.game.status).toBe("active");
    expect(view.version).toBe(before.game?.version);
    expect(await gameState(g.gameId)).toEqual(before);
  });
});

describe("§4 §6 GET returns full state in every status", () => {
  it.each<Status>(["setup", "rolled", "active", "finished", "abandoned"])("%s", async (status) => {
    const { code } = await gameIn(api, status);
    const row = await gameRow(code);
    const view = await readView(await api.get(gameUrl(code)));
    expect(view.game.status).toBe(status);
    expect(view.version).toBe(row.version);
    expect(view.game.durationMs).toBe(DURATION_MS);
    expect(view.teams.map((t) => t.slot)).toEqual([1, 2]);
    expect(view.tasks).toHaveLength(status === "setup" || status === "abandoned" ? 0 : TASKS_PER_GAME);
  });

  it("a rolled game lists the tasks in sortOrder with categories and empty completions", async () => {
    const { game } = await createGame(api);
    await rollGame(api, game.code);
    const view = await readView(await api.get(gameUrl(game.code)));
    expect(view.tasks.map((t) => t.sortOrder)).toEqual([1, 2, 3, 4]);
    expect(view.tasks.map((t) => t.categoryId)).toEqual(["drinks", "drinks", "food", "puzzle"]);
    const names = Object.fromEntries(ROLL_CATEGORIES.map((c) => [c.id, c.name]));
    for (const t of view.tasks) {
      expect(t).toEqual({
        id: expect.any(Number),
        sortOrder: expect.any(Number),
        categoryId: t.categoryId,
        categoryName: names[t.categoryId],
        text: expect.any(String),
        isFinal: t.categoryId === "puzzle",
        completedAt: [null, null],
      });
    }
    for (const team of view.teams) expect(team).toMatchObject({ score: 0, finalUnlocked: false, lastCompletedAt: null });
  });

  it("an active game shows scores, unlock state and lastCompletedAt per team", async () => {
    const g = await activeGame(api);
    const [t1, t2] = g.teamIds;
    ctx.advance(60_000);
    await completeAllNonFinal(api, g, t1);
    const t1Last = ctx.deps.now();
    ctx.advance(60_000);
    await readView(await complete(api, g.code, g.taskIds[0] as number, t2));
    const t2Last = ctx.deps.now();
    const view = await readView(await api.get(gameUrl(g.code)));
    expect(view.teams).toEqual([
      { id: t1, slot: 1, name: "Team 1", score: 3, finalUnlocked: true, lastCompletedAt: t1Last },
      { id: t2, slot: 2, name: "Team 2", score: 1, finalUnlocked: false, lastCompletedAt: t2Last },
    ]);
    expect(view.tasks[0]?.completedAt).toEqual([t1Last, t2Last]);
    expect(view.tasks[3]?.completedAt).toEqual([null, null]);
  });

  it("a finished game shows the winner, end reason and the final completion", async () => {
    const g = await activeGame(api);
    await completeAllNonFinal(api, g, g.teamIds[1]);
    ctx.advance(5 * 60_000);
    await readView(await complete(api, g.code, g.finalTaskId, g.teamIds[1]));
    const end = ctx.deps.now();
    ctx.advance(60_000);
    const view = await readView(await api.get(gameUrl(g.code)));
    expect(view.game).toMatchObject({ status: "finished", endReason: "completed", endedAt: end, winnerTeamId: g.teamIds[1] });
    expect(view.tasks.find((t) => t.isFinal)?.completedAt).toEqual([null, end]);
    expect(view.teams[1]).toMatchObject({ score: 4, lastCompletedAt: end });
  });

  it("an abandoned rolled game still shows its tasks", async () => {
    const { game } = await createGame(api);
    await rollGame(api, game.code);
    await readView(await abandon(api, game.code));
    const view = await readView(await api.get(gameUrl(game.code)));
    expect(view.game).toMatchObject({ status: "abandoned", endReason: null, winnerTeamId: null });
    expect(view.tasks).toHaveLength(TASKS_PER_GAME);
  });
});

describe("§4 GET finalizes an expired game exactly once", () => {
  it("at ends_at: finished by timeout, ended_at=ends_at, version +1, and a second GET doesn't bump again", async () => {
    const g = await activeGame(api);
    const v0 = (await gameRow(g.code)).version;
    ctx.setNow(g.endsAt);
    const first = await readView(await api.get(gameUrl(g.code)));
    expect(first.version).toBe(v0 + 1);
    expect(first.game).toMatchObject({ status: "finished", endReason: "timeout", endedAt: g.endsAt, winnerTeamId: null });
    expect(first.serverNow).toBe(g.endsAt);

    ctx.advance(10 * 60_000);
    const second = await readView(await api.get(gameUrl(g.code)));
    expect(second.version).toBe(v0 + 1);
    expect(second.game.endedAt).toBe(g.endsAt);
    expect(await eventCount(g.gameId)).toBe(0);
    expect(await gameRow(g.code)).toMatchObject({ status: "finished", end_reason: "timeout", ended_at: g.endsAt, version: v0 + 1 });
  });

  it("long after ends_at, ended_at is still ends_at (not the request time)", async () => {
    const g = await activeGame(api);
    ctx.setNow(g.endsAt + 3 * 24 * 3_600_000);
    const view = await readView(await api.get(gameUrl(g.code)));
    expect(view.game.endedAt).toBe(g.endsAt);
  });
});
