// SPEC.md §5 complete/undo: undo writes an event in the same batch, relocks the final task,
// and the final task can't be undone. §6 version, §10 undo endpoint.
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
  undo,
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

describe("§3 §10 undo: auth, lookup and validation", () => {
  it("401 without a session, with no writes", async () => {
    await readView(await complete(api, g.code, g.taskIds[0] as number, g.teamIds[0]));
    const before = await gameState(g.gameId);
    const res = await anonymous(ctx.deps, "POST", taskUrl(g.code, g.taskIds[0] as number, "undo"), { teamId: g.teamIds[0] });
    await expectApiError(res, 401, "unauthorized");
    expect(await gameState(g.gameId)).toEqual(before);
  });

  it.each(["ZZZZZ", "ABCD", "ABCD0"])("404 for unknown or malformed code %s", async (code) => {
    await expectApiError(await undo(api, code, g.taskIds[0] as number, g.teamIds[0]), 404, "not_found");
  });

  it.each(["abc", "1.5", "-1", "0"])("404 for a non-integer or nonexistent taskId %j", async (taskId) => {
    await expectApiError(await undo(api, g.code, taskId, g.teamIds[0]), 404, "not_found");
  });

  it.each<[string, unknown]>([
    ["missing teamId", {}],
    ["string teamId", { teamId: "1" }],
    ["fractional teamId", { teamId: 2.5 }],
    ["null teamId", { teamId: null }],
    ["array body", [1]],
  ])("422 validation for %s, with no writes", async (_name, body) => {
    await readView(await complete(api, g.code, g.taskIds[0] as number, g.teamIds[0]));
    const before = await gameState(g.gameId);
    await expectApiError(await api.post(taskUrl(g.code, g.taskIds[0] as number, "undo"), body), 422, "validation");
    expect(await gameState(g.gameId)).toEqual(before);
  });

  it("422 validation for invalid JSON", async () => {
    await expectApiError(await api.raw("POST", taskUrl(g.code, g.taskIds[0] as number, "undo"), "nope"), 422, "validation");
  });

  it("422 validation for a teamId that isn't a team of this game", async () => {
    await expectApiError(await undo(api, g.code, g.taskIds[0] as number, 99_999_999), 422, "validation");
  });
});

describe("§5 undo a completed task", () => {
  it("sets completed_at to null, writes one undo event at now, bumps version by exactly 1", async () => {
    const [t1, t2] = g.teamIds;
    const task = g.taskIds[0] as number;
    await readView(await complete(api, g.code, task, t1));
    const doneAt = ctx.deps.now();
    await readView(await complete(api, g.code, task, t2));
    const v0 = await v(g.code);
    ctx.advance(30_000);
    const now = ctx.deps.now();
    const view = await readView(await undo(api, g.code, task, t1));
    expect(view.version).toBe(v0 + 1);
    expect(completedAt(view, task)).toEqual([null, doneAt]);
    expect(teamView(view, 1)).toMatchObject({ score: 0, lastCompletedAt: null });
    expect(teamView(view, 2)).toMatchObject({ score: 1, lastCompletedAt: doneAt });
    expect(view.game.status).toBe("active");
    const tts = await teamTaskRows(g.gameId);
    expect(tts.find((r) => r.team_id === t1 && r.game_task_id === task)?.completed_at).toBeNull();
    expect(tts.find((r) => r.team_id === t2 && r.game_task_id === task)?.completed_at).toBe(doneAt);
    expect((await eventRows(g.gameId)).map((e) => [e.team_id, e.game_task_id, e.action, e.at])).toEqual([
      [t1, task, "complete", doneAt],
      [t2, task, "complete", doneAt],
      [t1, task, "undo", now],
    ]);
  });

  it("undoing a task that isn't completed is 200 with no bump and no event", async () => {
    const before = await gameState(g.gameId);
    const view = await readView(await undo(api, g.code, g.taskIds[1] as number, g.teamIds[1]));
    expect(view.version).toBe(g.view.version);
    expect(await gameState(g.gameId)).toEqual(before);
  });

  it("undoing only the other team's completion is a noop", async () => {
    await readView(await complete(api, g.code, g.taskIds[1] as number, g.teamIds[0]));
    const before = await gameState(g.gameId);
    await readView(await undo(api, g.code, g.taskIds[1] as number, g.teamIds[1]));
    expect(await gameState(g.gameId)).toEqual(before);
  });

  it("complete, undo, complete again: three events, three bumps, new completion time", async () => {
    const [t1] = g.teamIds;
    const task = g.taskIds[2] as number;
    await readView(await complete(api, g.code, task, t1));
    ctx.advance(1000);
    await readView(await undo(api, g.code, task, t1));
    ctx.advance(1000);
    const view = await readView(await complete(api, g.code, task, t1));
    expect(view.version).toBe(g.view.version + 3);
    expect(completedAt(view, task)).toEqual([ctx.deps.now(), null]);
    expect((await eventRows(g.gameId)).map((e) => e.action)).toEqual(["complete", "undo", "complete"]);
  });

  it("succeeds at ends_at - 1", async () => {
    await readView(await complete(api, g.code, g.taskIds[0] as number, g.teamIds[0]));
    ctx.setNow(g.endsAt - 1);
    const view = await readView(await undo(api, g.code, g.taskIds[0] as number, g.teamIds[0]));
    expect(completedAt(view, g.taskIds[0] as number)).toEqual([null, null]);
    expect((await eventRows(g.gameId)).at(-1)).toMatchObject({ action: "undo", at: g.endsAt - 1 });
  });
});

describe("§5 undo relocks the final task", () => {
  it("all non-final done unlocks; undoing one relocks, and completing the final gives 409", async () => {
    const [t1] = g.teamIds;
    const unlocked = await completeAllNonFinal(api, g, t1);
    expect(teamView(unlocked, 1).finalUnlocked).toBe(true);

    const relocked = await readView(await undo(api, g.code, g.taskIds[1] as number, t1));
    expect(teamView(relocked, 1).finalUnlocked).toBe(false);

    const before = await gameState(g.gameId);
    await expectApiError(await complete(api, g.code, g.finalTaskId, t1), 409, "final_locked");
    expect(await gameState(g.gameId)).toEqual(before);

    // Redoing the task unlocks it again and the final can be completed.
    await readView(await complete(api, g.code, g.taskIds[1] as number, t1));
    const done = await readView(await complete(api, g.code, g.finalTaskId, t1));
    expect(done.game).toMatchObject({ status: "finished", winnerTeamId: t1 });
  });
});

describe("§5 the final task can't be undone", () => {
  it("locked and not completed: 409 final_not_undoable, no writes", async () => {
    const before = await gameState(g.gameId);
    await expectApiError(await undo(api, g.code, g.finalTaskId, g.teamIds[0]), 409, "final_not_undoable");
    expect(await gameState(g.gameId)).toEqual(before);
  });

  it("unlocked: 409 final_not_undoable, no writes", async () => {
    await completeAllNonFinal(api, g, g.teamIds[1]);
    const before = await gameState(g.gameId);
    await expectApiError(await undo(api, g.code, g.finalTaskId, g.teamIds[1]), 409, "final_not_undoable");
    expect(await gameState(g.gameId)).toEqual(before);
  });

  it("after the final is completed the game is over: 409 game_over", async () => {
    await completeAllNonFinal(api, g, g.teamIds[1]);
    await readView(await complete(api, g.code, g.finalTaskId, g.teamIds[1]));
    const before = await gameState(g.gameId);
    await expectApiError(await undo(api, g.code, g.finalTaskId, g.teamIds[1]), 409, "game_over");
    await expectApiError(await undo(api, g.code, g.taskIds[0] as number, g.teamIds[1]), 409, "game_over");
    expect(await gameState(g.gameId)).toEqual(before);
  });
});

describe("§4 undo is allowed only while active (409)", () => {
  it("setup gives 409 invalid_state", async () => {
    const { code, gameId } = await gameIn(api, "setup");
    const before = await gameState(gameId);
    await expectApiError(await undo(api, code, 1, 1), 409, "invalid_state");
    expect(await gameState(gameId)).toEqual(before);
  });

  it("rolled gives 409 invalid_state", async () => {
    const r = await rolledGame(api);
    await expectApiError(await undo(api, r.code, r.taskIds[0] as number, r.teamIds[0]), 409, "invalid_state");
  });

  it("abandoned gives 409 game_over with no writes", async () => {
    await readView(await complete(api, g.code, g.taskIds[0] as number, g.teamIds[0]));
    await readView(await api.post(`/api/games/${g.code}/abandon`));
    const before = await gameState(g.gameId);
    await expectApiError(await undo(api, g.code, g.taskIds[0] as number, g.teamIds[0]), 409, "game_over");
    expect(await gameState(g.gameId)).toEqual(before);
  });
});

describe("§5 §8 undo scoping: ids from another game", () => {
  it("a teamId from another game gives 422 with no writes in either game", async () => {
    const other = await activeGame(api);
    await readView(await complete(api, other.code, other.taskIds[0] as number, other.teamIds[0]));
    await readView(await complete(api, g.code, g.taskIds[0] as number, g.teamIds[0]));
    const beforeA = await gameState(g.gameId);
    const beforeB = await gameState(other.gameId);
    await expectApiError(await undo(api, g.code, g.taskIds[0] as number, other.teamIds[0]), 422, "validation");
    expect(await gameState(g.gameId)).toEqual(beforeA);
    expect(await gameState(other.gameId)).toEqual(beforeB);
  });

  it("a taskId from another game gives 404 with no writes in either game", async () => {
    const other = await activeGame(api);
    await readView(await complete(api, other.code, other.taskIds[0] as number, other.teamIds[0]));
    const beforeA = await gameState(g.gameId);
    const beforeB = await gameState(other.gameId);
    await expectApiError(await undo(api, g.code, other.taskIds[0] as number, g.teamIds[0]), 404, "not_found");
    expect(await gameState(g.gameId)).toEqual(beforeA);
    expect(await gameState(other.gameId)).toEqual(beforeB);
  });
});
