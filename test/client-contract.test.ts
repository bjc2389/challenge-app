// SPEC.md §4 (code alphabet) and §10 (the game view): the client's copies must match
// what the Worker actually uses and returns. The type-level check runs under
// `npm run check` (tsc -p tsconfig.worker.json); the runtime checks run against D1.
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import * as clientCode from "../src/client/game/code";
import type { GameView, TaskView, TeamView } from "../src/client/game/types";
import { toGameView } from "../src/worker/api/view";
import * as workerConstants from "../src/worker/game/constants";
import { makeDeps } from "./helpers/auth";
import { resetDb } from "./helpers/db";
import { createGame, player, rollGame, seedRollCatalog } from "./helpers/game";

// Exhaustive at compile time: a missing or extra key fails the typecheck.
const TOP_KEYS: Record<keyof GameView, true> = { serverNow: true, version: true, game: true, teams: true, tasks: true };
const GAME_KEYS: Record<keyof GameView["game"], true> = {
  code: true,
  status: true,
  createdAt: true,
  rolledAt: true,
  startedAt: true,
  endsAt: true,
  endedAt: true,
  endReason: true,
  winnerTeamId: true,
  durationMs: true,
};
const TEAM_KEYS: Record<keyof TeamView, true> = {
  id: true,
  slot: true,
  name: true,
  score: true,
  finalUnlocked: true,
  lastCompletedAt: true,
};
const TASK_KEYS: Record<keyof TaskView, true> = {
  id: true,
  sortOrder: true,
  categoryId: true,
  categoryName: true,
  text: true,
  isFinal: true,
  completedAt: true,
};
const sorted = (o: object) => Object.keys(o).sort();

describe("§4 code constants: client matches worker", () => {
  it("CODE_ALPHABET", () => {
    expect(clientCode.CODE_ALPHABET).toBe(workerConstants.CODE_ALPHABET);
  });

  it("CODE_LENGTH", () => {
    expect(clientCode.CODE_LENGTH).toBe(workerConstants.CODE_LENGTH);
  });
});

describe("§10 GameView: client type equals the worker's toGameView", () => {
  it("type level", () => {
    expectTypeOf<ReturnType<typeof toGameView>>().toEqualTypeOf<GameView>();
    expectTypeOf<ReturnType<typeof toGameView>["teams"][number]>().toEqualTypeOf<TeamView>();
    expectTypeOf<ReturnType<typeof toGameView>["tasks"][number]>().toEqualTypeOf<TaskView>();
  });

  it("the documented key lists are the spec's", () => {
    expect(sorted(TOP_KEYS)).toEqual(["game", "serverNow", "tasks", "teams", "version"]);
    expect(sorted(GAME_KEYS)).toEqual(
      ["code", "createdAt", "durationMs", "endReason", "endedAt", "endsAt", "rolledAt", "startedAt", "status", "winnerTeamId"],
    );
    expect(sorted(TEAM_KEYS)).toEqual(["finalUnlocked", "id", "lastCompletedAt", "name", "score", "slot"]);
    expect(sorted(TASK_KEYS)).toEqual(["categoryId", "categoryName", "completedAt", "id", "isFinal", "sortOrder", "text"]);
  });
});

describe("§10 GameView: the real API response has exactly the client's keys", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("POST /api/games (201)", async () => {
    const api = await player(makeDeps().deps);
    const res = await api.post("/api/games");
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(sorted(body)).toEqual(sorted(TOP_KEYS));
    expect(sorted(body.game as object)).toEqual(sorted(GAME_KEYS));
    const teams = body.teams as object[];
    expect(teams).toHaveLength(2);
    for (const team of teams) expect(sorted(team)).toEqual(sorted(TEAM_KEYS));
    expect(body.tasks).toEqual([]);
  });

  it("after the roll, tasks[] entries have exactly the client's keys", async () => {
    await seedRollCatalog();
    const api = await player(makeDeps().deps);
    const created = await createGame(api);
    const view = await rollGame(api, created.game.code);
    expect(view.tasks.length).toBeGreaterThan(0);
    for (const task of view.tasks) {
      expect(sorted(task)).toEqual(sorted(TASK_KEYS));
      expect(task.completedAt).toHaveLength(2);
    }
  });
});
