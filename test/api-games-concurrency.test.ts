// SPEC.md §4 Completion: a conditional write, so two simultaneous finishes produce exactly
// one winner. §5: the state change and the event go in a single D1 batch. §6 version.
// Also the DB layer from the approved M3 plan: loadSnapshot, commitChange (version-guarded
// batch), finalizeIfExpired, readActiveCatalog.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { commitChange, finalizeIfExpired, loadSnapshot, readActiveCatalog } from "../src/worker/db/games";
import type { Change } from "../src/worker/game/types";
import { makeDeps } from "./helpers/auth";
import { resetDb } from "./helpers/db";
import {
  ROLL_CATEGORIES,
  ROLL_TASKS,
  activeGame,
  complete,
  completeAllNonFinal,
  eventRows,
  expectApiError,
  gameRow,
  gameState,
  gameUrl,
  player,
  readView,
  seedRollCatalog,
  teamTaskRows,
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

async function snapshotOrFail(code: string) {
  const snap = await loadSnapshot(env.DB, code);
  if (!snap) throw new Error(`no snapshot for ${code}`);
  return snap;
}

describe("§4 simultaneous finishes produce exactly one winner", () => {
  it("both teams unlocked, both finals at once, 10 rounds", async () => {
    for (let round = 0; round < 10; round++) {
      const game = round === 0 ? g : await activeGame(api);
      const [t1, t2] = game.teamIds;
      await completeAllNonFinal(api, game, t1);
      await completeAllNonFinal(api, game, t2);
      const v0 = (await gameRow(game.code)).version;
      ctx.advance(60_000);
      const now = ctx.deps.now();

      const [r1, r2] = await Promise.all([
        complete(api, game.code, game.finalTaskId, t1),
        complete(api, game.code, game.finalTaskId, t2),
      ]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses, `round ${round}`).toEqual([200, 409]);
      const [winRes, loseRes, winner, loser] = r1.status === 200 ? [r1, r2, t1, t2] : [r2, r1, t2, t1];

      const view = await readView(winRes);
      expect(view.game).toMatchObject({ status: "finished", endReason: "completed", endedAt: now, winnerTeamId: winner });
      expect(view.version).toBe(v0 + 1);
      await expectApiError(loseRes, 409, "game_over");

      expect(await gameRow(game.code)).toMatchObject({
        status: "finished",
        end_reason: "completed",
        ended_at: now,
        winner_team_id: winner,
        version: v0 + 1,
      });
      const finalEvents = (await eventRows(game.gameId)).filter((e) => e.game_task_id === game.finalTaskId);
      expect(finalEvents).toEqual([
        { id: expect.any(Number), game_id: game.gameId, team_id: winner, game_task_id: game.finalTaskId, action: "complete", at: now },
      ]);
      const tts = await teamTaskRows(game.gameId);
      expect(tts.find((r) => r.team_id === loser && r.game_task_id === game.finalTaskId)?.completed_at).toBeNull();
      expect(tts.find((r) => r.team_id === winner && r.game_task_id === game.finalTaskId)?.completed_at).toBe(now);
    }
  });
});

describe("§5 §6 simultaneous writes", () => {
  it("two simultaneous completes of the same task by the same team: both 200, one event, version +1", async () => {
    const [t1] = g.teamIds;
    const task = g.taskIds[0] as number;
    const v0 = (await gameRow(g.code)).version;
    const now = ctx.deps.now();
    const [a, b] = await Promise.all([complete(api, g.code, task, t1), complete(api, g.code, task, t1)]);
    const va = await readView(a);
    const vb = await readView(b);
    expect(va.version).toBe(v0 + 1);
    expect(vb.version).toBe(v0 + 1);
    expect(await eventRows(g.gameId)).toEqual([
      { id: expect.any(Number), game_id: g.gameId, team_id: t1, game_task_id: task, action: "complete", at: now },
    ]);
    expect((await gameRow(g.code)).version).toBe(v0 + 1);
  });

  it("two simultaneous completes of different tasks: both applied (the loser retries), version +2", async () => {
    const [t1, t2] = g.teamIds;
    const v0 = (await gameRow(g.code)).version;
    const [a, b] = await Promise.all([
      complete(api, g.code, g.taskIds[0] as number, t1),
      complete(api, g.code, g.taskIds[1] as number, t2),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await gameRow(g.code)).version).toBe(v0 + 2);
    expect(await eventRows(g.gameId)).toHaveLength(2);
    const view = await readView(await api.get(gameUrl(g.code)));
    expect(view.teams.map((t) => t.score)).toEqual([1, 1]);
  });
});

describe("§8 db layer: loadSnapshot", () => {
  it("returns null for an unknown code", async () => {
    expect(await loadSnapshot(env.DB, "ZZZZZ")).toBeNull();
  });

  it("loads the game, teams by slot, tasks by sortOrder and every team task", async () => {
    await readView(await complete(api, g.code, g.taskIds[0] as number, g.teamIds[1]));
    const snap = await snapshotOrFail(g.code);
    const row = await gameRow(g.code);
    expect(snap.game).toEqual({
      id: row.id,
      code: g.code,
      status: "active",
      version: row.version,
      createdAt: row.created_at,
      rolledAt: row.rolled_at,
      startedAt: row.started_at,
      endsAt: row.ends_at,
      endedAt: null,
      endReason: null,
      winnerTeamId: null,
    });
    expect(snap.teams).toEqual([
      { id: g.teamIds[0], slot: 1, name: "Team 1" },
      { id: g.teamIds[1], slot: 2, name: "Team 2" },
    ]);
    expect(snap.tasks.map((t) => t.id)).toEqual(g.view.tasks.map((t) => t.id));
    expect(snap.tasks.map((t) => t.sortOrder)).toEqual([1, 2, 3, 4]);
    expect(snap.tasks.map((t) => t.isFinal)).toEqual([false, false, false, true]);
    expect(snap.tasks[0]).toEqual({
      id: g.view.tasks[0]?.id,
      catalogTaskId: expect.any(String),
      categoryId: "drinks",
      categoryName: "Drinks",
      text: g.view.tasks[0]?.text,
      sortOrder: 1,
      isFinal: false,
    });
    expect(snap.teamTasks).toHaveLength(8);
    expect(snap.teamTasks.filter((tt) => tt.completedAt !== null)).toEqual([
      { teamId: g.teamIds[1], gameTaskId: g.taskIds[0], completedAt: ctx.deps.now() },
    ]);
  });
});

describe("§4 §6 db layer: commitChange is version-guarded and atomic", () => {
  it("applies a change at the current version and bumps it by 1", async () => {
    const snap = await snapshotOrFail(g.code);
    const at = ctx.deps.now();
    const change: Change = { kind: "complete", teamId: g.teamIds[0], gameTaskId: g.taskIds[2] as number, at, finish: null };
    expect(await commitChange(env.DB, snap.game.id, snap.game.version, change)).toBe(true);
    expect((await gameRow(g.code)).version).toBe(snap.game.version + 1);
    expect(await eventRows(g.gameId)).toEqual([
      { id: expect.any(Number), game_id: g.gameId, team_id: g.teamIds[0], game_task_id: g.taskIds[2], action: "complete", at },
    ]);
  });

  it("a lost race writes nothing: stale version returns false and leaves every row unchanged", async () => {
    const stale = await snapshotOrFail(g.code);
    // Another writer gets in first through the API.
    await readView(await complete(api, g.code, g.taskIds[0] as number, g.teamIds[0]));
    const after = await gameState(g.gameId);
    expect(after.game?.version).toBe(stale.game.version + 1);

    const change: Change = {
      kind: "complete",
      teamId: g.teamIds[1],
      gameTaskId: g.taskIds[1] as number,
      at: ctx.deps.now(),
      finish: null,
    };
    expect(await commitChange(env.DB, stale.game.id, stale.game.version, change)).toBe(false);
    expect(await gameState(g.gameId)).toEqual(after);
  });

  it("a stale finish loses to an abandon: false, the game stays abandoned with no winner", async () => {
    await completeAllNonFinal(api, g, g.teamIds[0]);
    const stale = await snapshotOrFail(g.code);
    await readView(await api.post(gameUrl(g.code, "/abandon")));
    const after = await gameState(g.gameId);
    const change: Change = {
      kind: "complete",
      teamId: g.teamIds[0],
      gameTaskId: g.finalTaskId,
      at: ctx.deps.now(),
      finish: { winnerTeamId: g.teamIds[0] },
    };
    expect(await commitChange(env.DB, stale.game.id, stale.game.version, change)).toBe(false);
    expect(await gameState(g.gameId)).toEqual(after);
    expect(after.game).toMatchObject({ status: "abandoned", winner_team_id: null });
  });

  it("a failing statement throws and the whole batch rolls back", async () => {
    const snap = await snapshotOrFail(g.code);
    const before = await gameState(g.gameId);
    const change: Change = { kind: "complete", teamId: g.teamIds[0], gameTaskId: 99_999_999, at: ctx.deps.now(), finish: null };
    await expect(commitChange(env.DB, snap.game.id, snap.game.version, change)).rejects.toThrow();
    expect(await gameState(g.gameId)).toEqual(before);
  });

  it("a failing finish rolls back too: the game stays active", async () => {
    await completeAllNonFinal(api, g, g.teamIds[0]);
    const snap = await snapshotOrFail(g.code);
    const before = await gameState(g.gameId);
    const change: Change = {
      kind: "complete",
      teamId: g.teamIds[0],
      gameTaskId: 99_999_999,
      at: ctx.deps.now(),
      finish: { winnerTeamId: g.teamIds[0] },
    };
    await expect(commitChange(env.DB, snap.game.id, snap.game.version, change)).rejects.toThrow();
    expect(await gameState(g.gameId)).toEqual(before);
    expect(before.game?.status).toBe("active");
  });
});

describe("§4 db layer: finalizeIfExpired", () => {
  it("leaves a live game alone (same snapshot, no writes)", async () => {
    const snap = await snapshotOrFail(g.code);
    const before = await gameState(g.gameId);
    const result = await finalizeIfExpired(env.DB, snap, g.endsAt - 1);
    expect(result).toEqual(snap);
    expect(await gameState(g.gameId)).toEqual(before);
  });

  it("finalizes an expired game once and returns the finished snapshot", async () => {
    await readView(await complete(api, g.code, g.taskIds[0] as number, g.teamIds[1]));
    const snap = await snapshotOrFail(g.code);
    const result = await finalizeIfExpired(env.DB, snap, g.endsAt);
    expect(result.game).toMatchObject({
      status: "finished",
      endReason: "timeout",
      endedAt: g.endsAt,
      winnerTeamId: g.teamIds[1],
      version: snap.game.version + 1,
    });
    expect(await gameRow(g.code)).toMatchObject({ status: "finished", version: snap.game.version + 1 });
    // Running it again on the finished snapshot changes nothing.
    const again = await finalizeIfExpired(env.DB, result, g.endsAt + 1000);
    expect(again.game.version).toBe(snap.game.version + 1);
    expect((await gameRow(g.code)).version).toBe(snap.game.version + 1);
  });

  it("finalizing with a stale snapshot doesn't double-bump", async () => {
    const snap = await snapshotOrFail(g.code);
    const first = await finalizeIfExpired(env.DB, snap, g.endsAt);
    const second = await finalizeIfExpired(env.DB, snap, g.endsAt);
    expect(first.game.status).toBe("finished");
    expect(second.game.status).toBe("finished");
    expect((await gameRow(g.code)).version).toBe(snap.game.version + 1);
  });
});

describe("§5 §7 db layer: readActiveCatalog", () => {
  it("maps every active category and active task from D1, and nothing inactive is marked active", async () => {
    const { categories, tasks } = await readActiveCatalog(env.DB);
    const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));

    expect(byId(categories.filter((c) => c.active))).toEqual(
      byId(
        ROLL_CATEGORIES.filter((c) => c.active === 1).map((c) => ({
          id: c.id,
          name: c.name,
          sortOrder: c.sortOrder,
          countPerGame: c.countPerGame,
          isFinal: c.isFinal === 1,
          active: true,
        })),
      ),
    );
    const inactiveCats = new Set(ROLL_CATEGORIES.filter((c) => c.active === 0).map((c) => c.id));
    for (const c of categories) if (inactiveCats.has(c.id)) expect(c.active).toBe(false);

    const activeCatIds = new Set(ROLL_CATEGORIES.filter((c) => c.active === 1).map((c) => c.id));
    expect(byId(tasks.filter((t) => t.active && activeCatIds.has(t.categoryId)))).toEqual(
      byId(
        ROLL_TASKS.filter((t) => t.active === 1 && activeCatIds.has(t.categoryId)).map((t) => ({
          id: t.id,
          categoryId: t.categoryId,
          text: t.text,
          active: true,
        })),
      ),
    );
    const inactiveTasks = new Set(ROLL_TASKS.filter((t) => t.active === 0).map((t) => t.id));
    for (const t of tasks) if (inactiveTasks.has(t.id)) expect(t.active).toBe(false);
  });
});
