// SPEC.md §4 Completion end condition, §5 puzzle lock and complete (event in the same batch,
// already-complete is a 200 no-op), §6 version, §8 task_events, §10 complete endpoint.
import { beforeEach, describe, expect, it } from "vitest";
import { makeDeps } from "./helpers/auth";
import { resetDb } from "./helpers/db";
import {
  activeGame,
  anonymous,
  complete,
  completeAllNonFinal,
  completedAt,
  eventRows,
  expectApiError,
  gameIn,
  gameRow,
  gameState,
  player,
  readView,
  rolledGame,
  seedRollCatalog,
  taskUrl,
  teamTaskRows,
  teamView,
  type ActiveGame,
  type Api,
} from "./helpers/game";

let ctx: ReturnType<typeof makeDeps>;
let api: Api;
let g: ActiveGame;

beforeEach(async () => {
  await resetDb();
  await seedRollCatalog();
  ctx = makeDeps();
  api = await player(ctx.deps);
  g = await activeGame(api);
  ctx.advance(60_000);
});

const v = async (code: string) => (await gameRow(code)).version;

describe("§3 §10 complete: auth, lookup and validation", () => {
  it("401 without a session, with no writes", async () => {
    const before = await gameState(g.gameId);
    const res = await anonymous(ctx.deps, "POST", taskUrl(g.code, g.taskIds[0] as number, "complete"), { teamId: g.teamIds[0] });
    await expectApiError(res, 401, "unauthorized");
    expect(await gameState(g.gameId)).toEqual(before);
  });

  it.each(["ZZZZZ", "ABCD", "ABCD0"])("404 for unknown or malformed code %s", async (code) => {
    await expectApiError(await complete(api, code, g.taskIds[0] as number, g.teamIds[0]), 404, "not_found");
  });

  it.each(["abc", "1.5", "-1", "0"])("404 for a non-integer or nonexistent taskId %j", async (taskId) => {
    const before = await gameState(g.gameId);
    await expectApiError(await complete(api, g.code, encodeURIComponent(taskId), g.teamIds[0]), 404, "not_found");
    expect(await gameState(g.gameId)).toEqual(before);
  });

  it("404 for an integer taskId that doesn't exist", async () => {
    await expectApiError(await complete(api, g.code, 99_999_999, g.teamIds[0]), 404, "not_found");
  });

  it.each<[string, unknown]>([
    ["missing teamId", {}],
    ["string teamId", { teamId: "1" }],
    ["fractional teamId", { teamId: 1.5 }],
    ["null teamId", { teamId: null }],
    ["boolean teamId", { teamId: true }],
    ["array body", [1]],
    ["null body", null],
  ])("422 validation for %s, with no writes", async (_name, body) => {
    const before = await gameState(g.gameId);
    await expectApiError(await api.post(taskUrl(g.code, g.taskIds[0] as number, "complete"), body), 422, "validation");
    expect(await gameState(g.gameId)).toEqual(before);
  });

  it("422 validation for invalid JSON and for no body", async () => {
    const url = taskUrl(g.code, g.taskIds[0] as number, "complete");
    await expectApiError(await api.raw("POST", url, "{teamId:"), 422, "validation");
    await expectApiError(await api.post(url), 422, "validation");
    expect(await v(g.code)).toBe(g.view.version);
  });

  it("422 validation for an integer teamId that isn't a team of this game", async () => {
    await expectApiError(await complete(api, g.code, g.taskIds[0] as number, 99_999_999), 422, "validation");
  });
});

describe("§5 complete a non-final task", () => {
  it("sets completed_at=now for that team only, writes one complete event, bumps version by exactly 1", async () => {
    const [t1, t2] = g.teamIds;
    const task = g.taskIds[1] as number;
    const now = ctx.deps.now();
    const view = await readView(await complete(api, g.code, task, t2));
    expect(view.version).toBe(g.view.version + 1);
    expect(view.serverNow).toBe(now);
    expect(completedAt(view, task)).toEqual([null, now]);
    expect(teamView(view, 2)).toMatchObject({ id: t2, score: 1, lastCompletedAt: now, finalUnlocked: false });
    expect(teamView(view, 1)).toMatchObject({ id: t1, score: 0, lastCompletedAt: null });
    expect(view.game.status).toBe("active");

    expect(await v(g.code)).toBe(g.view.version + 1);
    const tts = await teamTaskRows(g.gameId);
    for (const r of tts) {
      expect(r.completed_at).toBe(r.team_id === t2 && r.game_task_id === task ? now : null);
    }
    expect(await eventRows(g.gameId)).toEqual([
      { id: expect.any(Number), game_id: g.gameId, team_id: t2, game_task_id: task, action: "complete", at: now },
    ]);
  });

  it("completing an already-completed task is 200 and changes nothing (no bump, no event, original time kept)", async () => {
    const [t1] = g.teamIds;
    const task = g.taskIds[0] as number;
    const first = await readView(await complete(api, g.code, task, t1));
    const firstAt = ctx.deps.now();
    const before = await gameState(g.gameId);
    ctx.advance(60_000);
    const again = await readView(await complete(api, g.code, task, t1));
    expect(again.version).toBe(first.version);
    expect(completedAt(again, task)).toEqual([firstAt, null]);
    expect(await gameState(g.gameId)).toEqual(before);
  });

  it("each team completes independently, each a separate change", async () => {
    const [t1, t2] = g.teamIds;
    const task = g.taskIds[2] as number;
    const a = ctx.deps.now();
    await readView(await complete(api, g.code, task, t1));
    ctx.advance(1000);
    const b = ctx.deps.now();
    const view = await readView(await complete(api, g.code, task, t2));
    expect(view.version).toBe(g.view.version + 2);
    expect(completedAt(view, task)).toEqual([a, b]);
    expect((await eventRows(g.gameId)).map((e) => [e.team_id, e.action, e.at])).toEqual([
      [t1, "complete", a],
      [t2, "complete", b],
    ]);
  });

  it("tasks can be done in any order", async () => {
    const [t1] = g.teamIds;
    for (const task of [...g.taskIds].reverse()) await readView(await complete(api, g.code, task, t1));
    expect(teamView(await readView(await api.get(`/api/games/${g.code}`)), 1)).toMatchObject({ score: 3, finalUnlocked: true });
  });

  it("succeeds at ends_at - 1", async () => {
    ctx.setNow(g.endsAt - 1);
    const view = await readView(await complete(api, g.code, g.taskIds[0] as number, g.teamIds[0]));
    expect(completedAt(view, g.taskIds[0] as number)).toEqual([g.endsAt - 1, null]);
    expect(view.game.status).toBe("active");
  });

  it("the code is case-insensitive", async () => {
    await readView(await complete(api, g.code.toLowerCase(), g.taskIds[0] as number, g.teamIds[0]));
  });
});

describe("§5 the puzzle lock (server enforced, per team)", () => {
  it("the final task is locked with nothing done: 409 final_locked, no writes", async () => {
    for (const team of g.teamIds) {
      const before = await gameState(g.gameId);
      await expectApiError(await complete(api, g.code, g.finalTaskId, team), 409, "final_locked");
      expect(await gameState(g.gameId)).toEqual(before);
    }
  });

  it("stays locked with one non-final task left", async () => {
    const [t1] = g.teamIds;
    for (const task of g.taskIds.slice(0, -1)) await readView(await complete(api, g.code, task, t1));
    const before = await gameState(g.gameId);
    await expectApiError(await complete(api, g.code, g.finalTaskId, t1), 409, "final_locked");
    expect(await gameState(g.gameId)).toEqual(before);
  });

  it("team 1 finishing its tasks unlocks only team 1", async () => {
    const [t1, t2] = g.teamIds;
    const view = await completeAllNonFinal(api, g, t1);
    expect(teamView(view, 1)).toMatchObject({ finalUnlocked: true, score: 3 });
    expect(teamView(view, 2)).toMatchObject({ finalUnlocked: false, score: 0 });
    const before = await gameState(g.gameId);
    await expectApiError(await complete(api, g.code, g.finalTaskId, t2), 409, "final_locked");
    expect(await gameState(g.gameId)).toEqual(before);
  });

  it("team 2's completions don't unlock team 1", async () => {
    const [t1, t2] = g.teamIds;
    await completeAllNonFinal(api, g, t2);
    await readView(await complete(api, g.code, g.taskIds[0] as number, t1));
    await expectApiError(await complete(api, g.code, g.finalTaskId, t1), 409, "final_locked");
  });
});

describe("§4 completing the final task finishes the game", () => {
  it("finished, end_reason completed, ended_at=now, winner = that team, version +1 exactly", async () => {
    const [, t2] = g.teamIds;
    await completeAllNonFinal(api, g, t2);
    const v0 = await v(g.code);
    ctx.advance(7 * 60_000);
    const now = ctx.deps.now();
    const view = await readView(await complete(api, g.code, g.finalTaskId, t2));
    expect(view.version).toBe(v0 + 1);
    expect(view.game).toMatchObject({ status: "finished", endReason: "completed", endedAt: now, winnerTeamId: t2 });
    expect(completedAt(view, g.finalTaskId)).toEqual([null, now]);
    expect(teamView(view, 2)).toMatchObject({ score: 4, lastCompletedAt: now });
    expect(await gameRow(g.code)).toMatchObject({
      status: "finished",
      end_reason: "completed",
      ended_at: now,
      winner_team_id: t2,
      version: v0 + 1,
    });
    const events = await eventRows(g.gameId);
    expect(events.filter((e) => e.game_task_id === g.finalTaskId)).toEqual([
      { id: expect.any(Number), game_id: g.gameId, team_id: t2, game_task_id: g.finalTaskId, action: "complete", at: now },
    ]);
  });

  it("after the finish, any complete gives 409 game_over with no writes", async () => {
    const [t1, t2] = g.teamIds;
    await completeAllNonFinal(api, g, t1);
    await readView(await complete(api, g.code, g.finalTaskId, t1));
    const before = await gameState(g.gameId);
    await expectApiError(await complete(api, g.code, g.taskIds[0] as number, t2), 409, "game_over");
    await expectApiError(await complete(api, g.code, g.finalTaskId, t1), 409, "game_over");
    expect(await gameState(g.gameId)).toEqual(before);
  });
});

describe("§4 complete is allowed only while active (409)", () => {
  it("setup gives 409 invalid_state, even for a task id that doesn't exist", async () => {
    const { code, gameId } = await gameIn(api, "setup");
    const before = await gameState(gameId);
    await expectApiError(await complete(api, code, 1, 1), 409, "invalid_state");
    expect(await gameState(gameId)).toEqual(before);
  });

  it("rolled gives 409 invalid_state with no writes", async () => {
    const r = await rolledGame(api);
    const before = await gameState(r.gameId);
    await expectApiError(await complete(api, r.code, r.taskIds[0] as number, r.teamIds[0]), 409, "invalid_state");
    expect(await gameState(r.gameId)).toEqual(before);
  });

  it("abandoned gives 409 game_over with no writes", async () => {
    await readView(await api.post(`/api/games/${g.code}/abandon`));
    const before = await gameState(g.gameId);
    await expectApiError(await complete(api, g.code, g.taskIds[0] as number, g.teamIds[0]), 409, "game_over");
    expect(await gameState(g.gameId)).toEqual(before);
  });
});

describe("§5 §8 scoping: ids from another game", () => {
  it("a teamId from another game gives 422 with no writes in either game", async () => {
    const other = await activeGame(api);
    const beforeA = await gameState(g.gameId);
    const beforeB = await gameState(other.gameId);
    await expectApiError(await complete(api, g.code, g.taskIds[0] as number, other.teamIds[0]), 422, "validation");
    expect(await gameState(g.gameId)).toEqual(beforeA);
    expect(await gameState(other.gameId)).toEqual(beforeB);
  });

  it("a taskId from another game gives 404 with no writes in either game", async () => {
    const other = await activeGame(api);
    const beforeA = await gameState(g.gameId);
    const beforeB = await gameState(other.gameId);
    await expectApiError(await complete(api, g.code, other.taskIds[0] as number, g.teamIds[0]), 404, "not_found");
    await expectApiError(await complete(api, g.code, other.finalTaskId, g.teamIds[0]), 404, "not_found");
    expect(await gameState(g.gameId)).toEqual(beforeA);
    expect(await gameState(other.gameId)).toEqual(beforeB);
  });

  it("a team and task both from another game give 422 (team checked first)", async () => {
    const other = await activeGame(api);
    await expectApiError(await complete(api, g.code, other.taskIds[0] as number, other.teamIds[0]), 422, "validation");
    expect(await gameState(other.gameId)).toMatchObject({ events: [] });
  });
});
