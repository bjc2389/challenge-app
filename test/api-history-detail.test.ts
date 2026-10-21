// SPEC.md §9 /history/:code (teams, result, end reason, duration, each team's split per
// task from the start, the full event log including undos), §4 (codes are
// case-insensitive; an expired game is finalized by the first request that touches it)
// and §10 GET /api/history/:code (player session; 404 {error:"not_found", message:"Not found"}).
// Approved M5 plan: only finished/abandoned non-test games are visible; splits and puzzle
// times come from the final team_tasks state; events are ordered by at, then id.
import { beforeEach, describe, expect, it } from "vitest";
import { expectError, makeDeps } from "./helpers/auth";
import { T0, resetDb } from "./helpers/db";
import {
  anonymous,
  eventRows,
  gameRow,
  gameUrl,
  player,
  readView,
  seedRollCatalog,
  type ActiveGame,
  type Api,
} from "./helpers/game";
import {
  HOUR,
  MIN,
  abandonNow,
  expiredGame,
  getDetail,
  historyUrl,
  markTest,
  namedGame,
  play,
  redsBluesGame,
  rolledNamedGame,
  startedGame,
  timedOutGame,
  type Clock,
} from "./helpers/history";

let clock: Clock;
let api: Api;

beforeEach(async () => {
  await resetDb();
  await seedRollCatalog();
  clock = makeDeps();
  api = await player(clock.deps);
});

const expectNotFound = async (res: Response) => expectError(res, 404, "not_found", "Not found");

/** The rolled task list as the game view reports it, for building expected detail tasks. */
const viewTasks = (g: ActiveGame) => g.view.tasks;

describe("§3 §10 GET /api/history/:code needs a session", () => {
  it("401 without a cookie", async () => {
    await expectError(await anonymous(clock.deps, "GET", historyUrl("ABCDE")), 401, "unauthorized", "Log in to continue");
  });
});

describe("§10 GET /api/history/:code → 404 not_found", () => {
  it.each([
    ["too short", "ABCD"],
    ["too long", "ABCDEF"],
    ["a character outside the alphabet (0)", "ABCD0"],
    ["a character outside the alphabet (I)", "ABCDI"],
    ["punctuation", "AB-DE"],
  ])("a malformed code: %s", async (_name, code) => {
    await expectNotFound(await api.get(historyUrl(code)));
  });

  it("an unknown well-formed code", async () => {
    await redsBluesGame(api, clock, T0);
    await expectNotFound(await api.get(historyUrl("ZZZZZ")));
  });

  it("a finished test game", async () => {
    const g = await redsBluesGame(api, clock, T0);
    await markTest(g.code);
    await expectNotFound(await api.get(historyUrl(g.code)));
    await expectNotFound(await api.get(historyUrl(g.code.toLowerCase())));
  });

  it("an abandoned test game", async () => {
    const g = await namedGame(api, clock, { at: T0 });
    await abandonNow(api, g.code);
    await markTest(g.code);
    await expectNotFound(await api.get(historyUrl(g.code)));
  });

  it("a game in setup", async () => {
    const g = await namedGame(api, clock, { at: T0 });
    await expectNotFound(await api.get(historyUrl(g.code)));
  });

  it("a rolled game", async () => {
    const g = await rolledNamedGame(api, clock, { at: T0 });
    await expectNotFound(await api.get(historyUrl(g.code)));
  });

  it("an active game before ends_at (at ends_at − 1), which stays untouched", async () => {
    const g = await expiredGame(api, clock, { at: T0, steps: [{ slot: 1, task: 0, min: 5 }] });
    const before = await gameRow(g.code);
    clock.setNow(g.endsAt - 1);
    await expectNotFound(await api.get(historyUrl(g.code)));
    expect(await gameRow(g.code)).toEqual(before);
  });
});

describe("§9 §10 GET /api/history/:code → 200, a completion win with an undo and redo", () => {
  it("returns every field: game, teams (with puzzle time), tasks (with splits), events", async () => {
    const g = await redsBluesGame(api, clock, T0);
    const S = g.startedAt;
    const [reds, blues] = g.teamIds;
    const [t0, t1, t2] = g.taskIds as [number, number, number];
    const F = g.finalTaskId;
    const events = await eventRows(g.gameId);
    expect(events).toHaveLength(9);
    clock.setNow(S + 5 * HOUR);

    const detail = await getDetail(api, g.code);
    expect(detail.game).toEqual({
      code: g.code,
      status: "finished",
      createdAt: T0,
      startedAt: S,
      endsAt: g.endsAt,
      endedAt: S + 30 * MIN,
      endReason: "completed",
      winnerTeamId: reds,
      elapsedMs: 30 * MIN,
    });
    expect(detail.teams).toEqual([
      // Reds' last non-final completion is the redo at +20; the final at +30.
      { id: reds, slot: 1, name: "Reds", score: 4, puzzleMs: 10 * MIN },
      { id: blues, slot: 2, name: "Blues", score: 3, puzzleMs: null },
    ]);
    const split: Record<number, [number | null, number | null]> = {
      // Reds' task 0 was undone at +12 and redone at +20: the redo counts.
      [t0]: [20 * MIN, 6 * MIN],
      [t1]: [10 * MIN, 11 * MIN],
      [t2]: [3 * MIN, 25 * MIN],
      [F]: [30 * MIN, null],
    };
    expect(detail.tasks).toEqual(
      viewTasks(g).map((t) => ({
        id: t.id,
        sortOrder: t.sortOrder,
        categoryName: t.categoryName,
        text: t.text,
        isFinal: t.isFinal,
        splitMs: split[t.id],
      })),
    );
    expect(detail.tasks.map((t) => t.sortOrder)).toEqual([1, 2, 3, 4]);
    expect(detail.tasks[3]).toMatchObject({ isFinal: true, categoryName: "Final Puzzle" });

    const ev = (i: number, teamId: number, taskId: number, action: "complete" | "undo", min: number) => ({
      id: events[i]!.id,
      at: S + min * MIN,
      sinceStartMs: min * MIN,
      teamId,
      taskId,
      action,
    });
    expect(detail.events).toEqual([
      ev(0, reds, t2, "complete", 3),
      ev(1, reds, t0, "complete", 5),
      ev(2, blues, t0, "complete", 6),
      ev(3, reds, t1, "complete", 10),
      ev(4, blues, t1, "complete", 11),
      ev(5, reds, t0, "undo", 12),
      ev(6, reds, t0, "complete", 20),
      ev(7, blues, t2, "complete", 25),
      ev(8, reds, F, "complete", 30),
    ]);
  });

  it("a lowercase code works and returns the canonical code", async () => {
    const g = await redsBluesGame(api, clock, T0);
    const detail = await getDetail(api, g.code.toLowerCase());
    expect(detail.game.code).toBe(g.code);
    expect(detail.teams.map((t) => t.name)).toEqual(["Reds", "Blues"]);
  });

  it("an undone task that wasn't redone has a null split", async () => {
    const g = await startedGame(api, clock, { at: T0 });
    await play(api, clock, g, [
      { slot: 2, task: 1, min: 4 },
      { slot: 2, task: 1, min: 9, action: "undo" },
      { slot: 1, task: 0, min: 1 + 10 },
      { slot: 1, task: 1, min: 12 },
      { slot: 1, task: 2, min: 13 },
      { slot: 1, task: "final", min: 40 },
    ]);
    const detail = await getDetail(api, g.code);
    const task1 = detail.tasks.find((t) => t.id === g.taskIds[1]);
    expect(task1?.splitMs).toEqual([12 * MIN, null]);
    expect(detail.teams[1]).toMatchObject({ score: 0, puzzleMs: null });
    expect(detail.teams[0]).toMatchObject({ score: 4, puzzleMs: 27 * MIN });
    // The undone completion and the undo itself are both in the log.
    expect(detail.events.filter((e) => e.teamId === g.teamIds[1]).map((e) => [e.action, e.sinceStartMs])).toEqual([
      ["complete", 4 * MIN],
      ["undo", 9 * MIN],
    ]);
  });
});

describe("§9 event log order: at, then id", () => {
  it("two events in the same ms come in id order; earlier `at` comes first even with a higher id", async () => {
    const g = await startedGame(api, clock, { at: T0 });
    const [reds, blues] = g.teamIds;
    const [t0, t1] = g.taskIds as [number, number];
    // Blues (the higher team id) first, then Reds, in the same ms.
    await play(api, clock, g, [
      { slot: 2, task: 0, min: 10 },
      { slot: 1, task: 0, min: 10 },
    ]);
    // The injected clock moves back: this event has the highest id but the earliest `at`.
    await play(api, clock, g, [{ slot: 1, task: 1, min: 4 }]);
    clock.setNow(T0 + 20 * MIN);
    await abandonNow(api, g.code);

    const rows = await eventRows(g.gameId);
    expect(rows.map((r) => r.at)).toEqual([g.startedAt + 10 * MIN, g.startedAt + 10 * MIN, g.startedAt + 4 * MIN]);
    const detail = await getDetail(api, g.code);
    expect(detail.events.map((e) => [e.id, e.teamId, e.taskId, e.sinceStartMs])).toEqual([
      [rows[2]!.id, reds, t1, 4 * MIN],
      [rows[0]!.id, blues, t0, 10 * MIN],
      [rows[1]!.id, reds, t0, 10 * MIN],
    ]);
  });
});

describe("§4 §9 a timed-out game", () => {
  it("shows endReason timeout, endedAt = endsAt and a 60-minute duration", async () => {
    const g = await timedOutGame(api, clock, {
      at: T0,
      steps: [
        { slot: 2, task: 0, min: 10 },
        { slot: 2, task: 1, min: 20 },
        { slot: 1, task: 0, min: 30 },
      ],
    });
    const detail = await getDetail(api, g.code);
    expect(detail.game).toMatchObject({
      status: "finished",
      endReason: "timeout",
      endedAt: g.endsAt,
      winnerTeamId: g.teamIds[1],
      elapsedMs: HOUR,
    });
    expect(detail.teams.map((t) => [t.score, t.puzzleMs])).toEqual([
      [1, null],
      [2, null],
    ]);
    expect(detail.tasks.find((t) => t.isFinal)?.splitMs).toEqual([null, null]);
  });
});

describe("§4 §9 an expired active game is finalized by the detail request itself", () => {
  it.each([
    ["exactly at ends_at", 0],
    ["long after ends_at", 3 * HOUR],
  ])("%s: 200, finished by timeout, ended_at = ends_at, version +1", async (_name, offset) => {
    const g = await expiredGame(api, clock, {
      at: T0,
      steps: [
        { slot: 1, task: 0, min: 10 },
        { slot: 1, task: 1, min: 11 },
        { slot: 2, task: 0, min: 5 },
      ],
    });
    const v0 = (await gameRow(g.code)).version;
    clock.setNow(g.endsAt + offset);
    const detail = await getDetail(api, g.code);
    expect(detail.game).toMatchObject({
      status: "finished",
      endReason: "timeout",
      endedAt: g.endsAt,
      winnerTeamId: g.teamIds[0],
      elapsedMs: HOUR,
    });
    expect(await gameRow(g.code)).toMatchObject({
      status: "finished",
      end_reason: "timeout",
      ended_at: g.endsAt,
      winner_team_id: g.teamIds[0],
      version: v0 + 1,
    });
  });
});

describe("§4 §9 abandoned games", () => {
  it("abandoned in setup: no start, empty tasks and events, elapsedMs null", async () => {
    const g = await namedGame(api, clock, { at: T0, names: ["Ambers", "Teals"] });
    clock.setNow(T0 + 7 * MIN);
    await abandonNow(api, g.code);
    const teams = (await readView(await api.get(gameUrl(g.code)))).teams;
    expect(await getDetail(api, g.code)).toEqual({
      game: {
        code: g.code,
        status: "abandoned",
        createdAt: T0,
        startedAt: null,
        endsAt: null,
        endedAt: T0 + 7 * MIN,
        endReason: null,
        winnerTeamId: null,
        elapsedMs: null,
      },
      teams: [
        { id: teams[0]!.id, slot: 1, name: "Ambers", score: 0, puzzleMs: null },
        { id: teams[1]!.id, slot: 2, name: "Teals", score: 0, puzzleMs: null },
      ],
      tasks: [],
      events: [],
    });
  });

  it("abandoned after the roll: tasks with null splits, no events", async () => {
    const g = await rolledNamedGame(api, clock, { at: T0 });
    clock.setNow(T0 + 5 * MIN);
    await abandonNow(api, g.code);
    const detail = await getDetail(api, g.code);
    expect(detail.game).toMatchObject({ status: "abandoned", startedAt: null, elapsedMs: null, endedAt: T0 + 5 * MIN });
    expect(detail.tasks).toHaveLength(4);
    for (const t of detail.tasks) expect(t.splitMs).toEqual([null, null]);
    expect(detail.events).toEqual([]);
  });

  it("abandoned while active: duration from start to abandon, splits and events kept", async () => {
    const g = await startedGame(api, clock, { at: T0 });
    await play(api, clock, g, [{ slot: 1, task: 2, min: 8 }]);
    clock.setNow(g.startedAt + 15 * MIN);
    await abandonNow(api, g.code);
    const detail = await getDetail(api, g.code);
    expect(detail.game).toMatchObject({
      status: "abandoned",
      startedAt: g.startedAt,
      endedAt: g.startedAt + 15 * MIN,
      endReason: null,
      winnerTeamId: null,
      elapsedMs: 15 * MIN,
    });
    expect(detail.tasks.find((t) => t.id === g.taskIds[2])?.splitMs).toEqual([8 * MIN, null]);
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0]).toMatchObject({ teamId: g.teamIds[0], taskId: g.taskIds[2], action: "complete", sinceStartMs: 8 * MIN });
  });
});

describe("§9 GET /api/history/:code writes nothing for a game that is already over", () => {
  it("leaves the row and version unchanged", async () => {
    const g = await redsBluesGame(api, clock, T0);
    const before = await gameRow(g.code);
    clock.advance(10 * HOUR);
    await getDetail(api, g.code);
    expect(await gameRow(g.code)).toEqual(before);
  });
});
