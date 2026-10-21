// SPEC.md §4 Setup → Rolled (no re-rolling), §5 Rolling (catalog from D1, text copied,
// both teams the same list), §8 game_tasks/team_tasks, §10 POST /api/games/:code/roll.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { makeDeps, NOW } from "./helpers/auth";
import { resetDb } from "./helpers/db";
import {
  INELIGIBLE_IDS,
  NON_FINAL_PER_GAME,
  ROLL_TASKS,
  TASKS_PER_GAME,
  anonymous,
  createGame,
  eventCount,
  expectApiError,
  gameIn,
  gameRow,
  gameState,
  gameTaskRows,
  gameUrl,
  player,
  readView,
  seedRollCatalog,
  seqRandom,
  teamRows,
  teamTaskRows,
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

const roll = (code: string) => api.post(gameUrl(code, "/roll"));

describe("§3 §10 POST /api/games/:code/roll auth and lookup", () => {
  it("401 without a session, and the game stays in setup", async () => {
    const { game } = await createGame(api);
    await expectApiError(await anonymous(ctx.deps, "POST", gameUrl(game.code, "/roll")), 401, "unauthorized");
    expect((await gameRow(game.code)).status).toBe("setup");
  });

  it.each(["ZZZZZ", "ABCD", "ABCD0"])("404 for unknown or malformed code %s", async (code) => {
    await expectApiError(await roll(code), 404, "not_found");
  });

  it("the code is case-insensitive", async () => {
    const { game } = await createGame(api);
    expect((await readView(await roll(game.code.toLowerCase()))).game.status).toBe("rolled");
  });
});

describe("§4 §5 roll in setup", () => {
  it("sets rolled, rolled_at=now, version +1, and returns the task list", async () => {
    const { game } = await createGame(api);
    ctx.advance(30_000);
    const view = await readView(await roll(game.code));
    expect(view.version).toBe(1);
    expect(view.serverNow).toBe(NOW + 30_000);
    expect(view.game).toMatchObject({ status: "rolled", rolledAt: NOW + 30_000, startedAt: null, endsAt: null });
    expect(view.tasks).toHaveLength(TASKS_PER_GAME);
    expect(view.tasks.map((t) => t.sortOrder)).toEqual([1, 2, 3, 4]);
    expect(view.tasks.map((t) => t.categoryId)).toEqual(["drinks", "drinks", "food", "puzzle"]);
    expect(view.tasks.map((t) => t.categoryName)).toEqual(["Drinks", "Drinks", "Food", "Final Puzzle"]);
    expect(view.tasks.map((t) => t.isFinal)).toEqual([false, false, false, true]);
    for (const t of view.tasks) expect(t.completedAt).toEqual([null, null]);
    for (const team of view.teams) expect(team).toMatchObject({ score: 0, finalUnlocked: false, lastCompletedAt: null });
    expect(await gameRow(game.code)).toMatchObject({ status: "rolled", rolled_at: NOW + 30_000, version: 1 });
  });

  it("writes game_tasks with copied text, and team_tasks for both teams × every task (null)", async () => {
    const { game } = await createGame(api);
    const view = await readView(await roll(game.code));
    const gameId = (await gameRow(game.code)).id;
    const gts = await gameTaskRows(gameId);
    expect(gts.map((r) => r.id)).toEqual(view.tasks.map((t) => t.id));
    const catalogText = Object.fromEntries(ROLL_TASKS.map((t) => [t.id, t.text]));
    for (const [i, r] of gts.entries()) {
      expect(r.text).toBe(catalogText[r.catalog_task_id]);
      expect(r.sort_order).toBe(i + 1);
      expect(r.is_final).toBe(i === TASKS_PER_GAME - 1 ? 1 : 0);
      expect(view.tasks[i]?.text).toBe(r.text);
    }
    expect(new Set(gts.map((r) => r.catalog_task_id)).size).toBe(TASKS_PER_GAME);

    // Both teams get the same list.
    const teams = await teamRows(gameId);
    const tts = await teamTaskRows(gameId);
    expect(tts).toHaveLength(2 * TASKS_PER_GAME);
    for (const team of teams) {
      const mine = tts.filter((r) => r.team_id === team.id);
      expect(mine.map((r) => r.game_task_id).sort((a, b) => a - b)).toEqual(gts.map((r) => r.id).sort((a, b) => a - b));
      for (const r of mine) expect(r.completed_at).toBeNull();
    }
    expect(await eventCount(gameId)).toBe(0);
  });

  it("picks exactly the tasks the injected random source selects", async () => {
    // Code AAAAA (5 × 0), then the roll:
    // drinks [a,b,c]: rand(3)=2 -> [c,b,a]; rand(2)=1 -> j=2 -> [c,a,b] -> drinks-c, drinks-a
    // food [a,b]: rand(2)=1 -> food-b; puzzle [a,b]: rand(2)=0 -> puzzle-a
    const rand = seqRandom([0, 0, 0, 0, 0, 2, 1, 1, 0]);
    const api2 = await player(makeDeps({ random: rand }).deps);
    const { game } = await readView(await api2.post("/api/games"), 201);
    expect(game.code).toBe("AAAAA");
    const view = await readView(await api2.post(gameUrl(game.code, "/roll")));
    expect(rand.calls.slice(5)).toEqual([3, 2, 2, 2]);
    expect(rand.remaining()).toBe(0);
    expect(view.tasks.map((t) => [t.sortOrder, t.categoryId, t.text, t.isFinal])).toEqual([
      [1, "drinks", "Drink C", false],
      [2, "drinks", "Drink A", false],
      [3, "food", "Food B", false],
      [4, "puzzle", "Puzzle A", true],
    ]);
    const gts = await gameTaskRows((await gameRow("AAAAA")).id);
    expect(gts.map((r) => r.catalog_task_id)).toEqual(["drinks-c", "drinks-a", "food-b", "puzzle-a"]);
  });

  it("never picks inactive tasks or tasks from inactive categories (20 real rolls)", async () => {
    for (let i = 0; i < 20; i++) {
      const { game } = await createGame(api);
      await readView(await roll(game.code));
      const ids = (await gameTaskRows((await gameRow(game.code)).id)).map((r) => r.catalog_task_id);
      for (const bad of INELIGIBLE_IDS) expect(ids).not.toContain(bad);
      expect(ids).toHaveLength(NON_FINAL_PER_GAME + 1);
    }
  });
});

describe("§5 task text is copied into the game", () => {
  it("a later catalog edit or deactivation doesn't change a rolled game", async () => {
    const { game } = await createGame(api);
    const rolled = await readView(await roll(game.code));
    const gameId = (await gameRow(game.code)).id;
    const before = await gameTaskRows(gameId);
    await env.DB.batch([
      env.DB.prepare("UPDATE catalog_tasks SET text = ?").bind("Edited later"),
      env.DB.prepare("UPDATE catalog_tasks SET active = ?").bind(0),
    ]);
    const after = await readView(await api.get(gameUrl(game.code)));
    expect(after.tasks.map((t) => [t.id, t.text, t.sortOrder, t.isFinal])).toEqual(
      rolled.tasks.map((t) => [t.id, t.text, t.sortOrder, t.isFinal]),
    );
    expect(await gameTaskRows(gameId)).toEqual(before);
  });
});

describe("§4 no re-rolling; roll only in setup (409)", () => {
  it("a second roll gives 409 invalid_state and changes nothing", async () => {
    const { game } = await createGame(api);
    await readView(await roll(game.code));
    const gameId = (await gameRow(game.code)).id;
    const before = await gameState(gameId);
    ctx.advance(1000);
    await expectApiError(await roll(game.code), 409, "invalid_state");
    expect(await gameState(gameId)).toEqual(before);
  });

  it.each([
    ["active", "invalid_state"],
    ["finished", "game_over"],
    ["abandoned", "game_over"],
  ] as const)("%s gives 409 %s with no writes", async (status, error) => {
    const { code, gameId } = await gameIn(api, status);
    const before = await gameState(gameId);
    await expectApiError(await roll(code), 409, error);
    expect(await gameState(gameId)).toEqual(before);
  });

  it("an abandoned setup game can't be rolled and gets no tasks", async () => {
    const { code, gameId } = await gameIn(api, "abandoned");
    await expectApiError(await roll(code), 409, "game_over");
    expect(await gameTaskRows(gameId)).toEqual([]);
  });
});

describe("§5 §7 short catalog at roll time (409 catalog_incomplete)", () => {
  it("a category with too few active tasks: message names it, game stays in setup untouched", async () => {
    const { game } = await createGame(api);
    await env.DB.prepare("UPDATE catalog_tasks SET active = 0 WHERE id IN (?, ?)").bind("drinks-b", "drinks-c").run();
    const gameId = (await gameRow(game.code)).id;
    const before = await gameState(gameId);
    const body = await expectApiError(await roll(game.code), 409, "catalog_incomplete");
    expect(body.message).toContain("Drinks");
    expect(await gameState(gameId)).toEqual(before);
    expect(before.game).toMatchObject({ status: "setup", version: 0, rolled_at: null });
    expect(await teamTaskRows(gameId)).toEqual([]);
  });

  it("the final category with no active tasks names the final category", async () => {
    const { game } = await createGame(api);
    await env.DB.prepare("UPDATE catalog_tasks SET active = 0 WHERE category_id = ?").bind("puzzle").run();
    const body = await expectApiError(await roll(game.code), 409, "catalog_incomplete");
    expect(body.message).toContain("Final Puzzle");
    expect((await gameRow(game.code)).status).toBe("setup");
  });

  it("the catalog is read at roll time: fixing it lets the same game roll", async () => {
    const { game } = await createGame(api);
    await env.DB.prepare("UPDATE catalog_tasks SET active = 0 WHERE category_id = ?").bind("food").run();
    await expectApiError(await roll(game.code), 409, "catalog_incomplete");
    await env.DB.prepare("UPDATE catalog_tasks SET active = 1 WHERE id = ?").bind("food-a").run();
    const view = await readView(await roll(game.code));
    expect(view.version).toBe(1);
    expect(view.tasks.find((t) => t.categoryId === "food")?.text).toBe("Food A");
  });

  it("a catalog with no active final category gives 409 catalog_incomplete", async () => {
    const { game } = await createGame(api);
    await env.DB.prepare("UPDATE categories SET active = 0 WHERE id = ?").bind("puzzle").run();
    await expectApiError(await roll(game.code), 409, "catalog_incomplete");
    expect(await gameRow(game.code)).toMatchObject({ status: "setup", version: 0 });
  });

  it("an empty catalog gives 409 catalog_incomplete", async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM catalog_tasks"), env.DB.prepare("DELETE FROM categories")]);
    const { game } = await createGame(api);
    await expectApiError(await roll(game.code), 409, "catalog_incomplete");
    expect(await gameRow(game.code)).toMatchObject({ status: "setup", version: 0 });
  });
});
