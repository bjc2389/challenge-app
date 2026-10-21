// Shared helpers for the M3 game API tests (SPEC.md §4, §5, §6, §8, §10).
// Every statement that carries a value is prepared and bound; nothing is interpolated.
// Time moves only through the injected clock in makeDeps (setNow/advance).
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import type { RandomInt } from "../../src/worker/game/types";
import { cookieFor, testApp, type Deps } from "./auth";

export const DURATION_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Scripted random source
// ---------------------------------------------------------------------------

export type SeqRandom = RandomInt & {
  /** The maxExclusive argument of every call, in order. */
  calls: number[];
  /** Scripted values not yet consumed. */
  remaining(): number;
};

/**
 * A RandomInt that returns `values` in order. It throws when it runs out, and when a
 * scripted value is not an integer in [0, maxExclusive), so a test can't silently
 * feed an impossible value.
 */
export function seqRandom(values: readonly number[]): SeqRandom {
  let i = 0;
  const calls: number[] = [];
  const fn = (maxExclusive: number): number => {
    calls.push(maxExclusive);
    if (i >= values.length) throw new Error(`seqRandom: ran out after ${values.length} values`);
    const v = values[i++] as number;
    if (!Number.isInteger(v) || v < 0 || v >= maxExclusive) {
      throw new Error(`seqRandom: scripted value ${v} is out of range for maxExclusive ${maxExclusive}`);
    }
    return v;
  };
  return Object.assign(fn, { calls, remaining: () => values.length - i });
}

// ---------------------------------------------------------------------------
// Catalog seed for rolling
// ---------------------------------------------------------------------------

type SeedCategory = { id: string; name: string; sortOrder: number; countPerGame: number; isFinal: 0 | 1; active: 0 | 1 };
type SeedCatalogTask = { id: string; categoryId: string; text: string; active: 0 | 1 };

/**
 * Active: drinks (2 per game, 3 active tasks + 1 inactive), food (1 per game, 2 tasks),
 * puzzle (final, 1 per game, 2 tasks).
 * Inactive: "retired" (non-final) and "old-puzzle" (final), each with an active task.
 * A game rolls 4 tasks: drinks, drinks, food, puzzle.
 */
export const ROLL_CATEGORIES: SeedCategory[] = [
  { id: "drinks", name: "Drinks", sortOrder: 1, countPerGame: 2, isFinal: 0, active: 1 },
  { id: "food", name: "Food", sortOrder: 2, countPerGame: 1, isFinal: 0, active: 1 },
  { id: "retired", name: "Retired", sortOrder: 3, countPerGame: 1, isFinal: 0, active: 0 },
  { id: "puzzle", name: "Final Puzzle", sortOrder: 4, countPerGame: 1, isFinal: 1, active: 1 },
  { id: "old-puzzle", name: "Old Puzzle", sortOrder: 5, countPerGame: 1, isFinal: 1, active: 0 },
];

export const ROLL_TASKS: SeedCatalogTask[] = [
  { id: "drinks-a", categoryId: "drinks", text: "Drink A", active: 1 },
  { id: "drinks-b", categoryId: "drinks", text: "Drink B", active: 1 },
  { id: "drinks-c", categoryId: "drinks", text: "Drink C", active: 1 },
  { id: "drinks-off", categoryId: "drinks", text: "Drink Off", active: 0 },
  { id: "food-a", categoryId: "food", text: "Food A", active: 1 },
  { id: "food-b", categoryId: "food", text: "Food B", active: 1 },
  { id: "retired-a", categoryId: "retired", text: "Retired A", active: 1 },
  { id: "puzzle-a", categoryId: "puzzle", text: "Puzzle A", active: 1 },
  { id: "puzzle-b", categoryId: "puzzle", text: "Puzzle B", active: 1 },
  { id: "old-puzzle-a", categoryId: "old-puzzle", text: "Old Puzzle A", active: 1 },
];

export const TASKS_PER_GAME = 4;
export const NON_FINAL_PER_GAME = 3;
export const ELIGIBLE_IDS = ["drinks-a", "drinks-b", "drinks-c", "food-a", "food-b", "puzzle-a", "puzzle-b"];
export const INELIGIBLE_IDS = ["drinks-off", "retired-a", "old-puzzle-a"];

export async function seedRollCatalog(): Promise<void> {
  await env.DB.batch([
    ...ROLL_CATEGORIES.map((c) =>
      env.DB.prepare(
        "INSERT INTO categories (id, name, sort_order, count_per_game, is_final, active) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(c.id, c.name, c.sortOrder, c.countPerGame, c.isFinal, c.active),
    ),
    ...ROLL_TASKS.map((t) =>
      env.DB.prepare("INSERT INTO catalog_tasks (id, category_id, text, active) VALUES (?, ?, ?, ?)").bind(
        t.id,
        t.categoryId,
        t.text,
        t.active,
      ),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// GameView (the success body of every game endpoint)
// ---------------------------------------------------------------------------

export type TeamView = {
  id: number;
  slot: 1 | 2;
  name: string;
  score: number;
  finalUnlocked: boolean;
  lastCompletedAt: number | null;
};

export type TaskView = {
  id: number;
  sortOrder: number;
  categoryId: string;
  categoryName: string;
  text: string;
  isFinal: boolean;
  completedAt: [number | null, number | null];
};

export type GameView = {
  serverNow: number;
  version: number;
  game: {
    code: string;
    status: string;
    createdAt: number;
    rolledAt: number | null;
    startedAt: number | null;
    endsAt: number | null;
    endedAt: number | null;
    endReason: "completed" | "timeout" | null;
    winnerTeamId: number | null;
    durationMs: number;
  };
  teams: TeamView[];
  tasks: TaskView[];
};

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const gameUrl = (code: string, suffix = "") => `/api/games/${code}${suffix}`;
export const taskUrl = (code: string, taskId: number | string, action: "complete" | "undo") =>
  `/api/games/${code}/tasks/${taskId}/${action}`;

export type Api = {
  deps: Deps;
  /** JSON request with a player cookie. `body` undefined sends no body. */
  request(method: string, path: string, body?: unknown): Promise<Response>;
  /** Request with a raw (possibly invalid) body. */
  raw(method: string, path: string, body: string, contentType?: string): Promise<Response>;
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown): Promise<Response>;
  patch(path: string, body?: unknown): Promise<Response>;
};

/** A request helper carrying a player cookie signed at runtime with the fake secret. */
export async function player(deps: Deps): Promise<Api> {
  const cookie = await cookieFor("player");
  const app = testApp(deps);
  const raw = (method: string, path: string, body?: string, contentType = "application/json") =>
    app.request(path, {
      method,
      headers: body === undefined ? { cookie } : { cookie, "content-type": contentType },
      body,
    });
  const request = (method: string, path: string, body?: unknown) =>
    raw(method, path, body === undefined ? undefined : JSON.stringify(body));
  return {
    deps,
    request,
    raw: (method, path, body, contentType) => raw(method, path, body, contentType),
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    patch: (path, body) => request("PATCH", path, body),
  };
}

/** The same request with no cookie at all. */
export function anonymous(deps: Deps, method: string, path: string, body?: unknown): Promise<Response> {
  return testApp(deps).request(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Asserts the status and parses the GameView. The body is included in the failure message. */
export async function readView(res: Response, status = 200): Promise<GameView> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as GameView;
}

/** §10: `{error, message}` and nothing else; `error` exact, `message` a non-empty string. */
export async function expectApiError(res: Response, status: number, error: string): Promise<{ error: string; message: string }> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  const body = JSON.parse(text) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["error", "message"]);
  expect(body.error).toBe(error);
  expect(typeof body.message).toBe("string");
  expect((body.message as string).length).toBeGreaterThan(0);
  return body as { error: string; message: string };
}

export async function createGame(api: Api): Promise<GameView> {
  return readView(await api.post("/api/games"), 201);
}

export async function rollGame(api: Api, code: string): Promise<GameView> {
  return readView(await api.post(gameUrl(code, "/roll")));
}

export async function startGame(api: Api, code: string): Promise<GameView> {
  return readView(await api.post(gameUrl(code, "/start")));
}

export function complete(api: Api, code: string, taskId: number | string, teamId: unknown): Promise<Response> {
  return api.post(taskUrl(code, taskId, "complete"), { teamId });
}

export function undo(api: Api, code: string, taskId: number | string, teamId: unknown): Promise<Response> {
  return api.post(taskUrl(code, taskId, "undo"), { teamId });
}

export function abandon(api: Api, code: string): Promise<Response> {
  return api.post(gameUrl(code, "/abandon"));
}

export type ActiveGame = {
  code: string;
  gameId: number;
  view: GameView;
  /** [slot 1 team id, slot 2 team id] */
  teamIds: [number, number];
  /** Non-final game task ids in sortOrder. */
  taskIds: number[];
  finalTaskId: number;
  startedAt: number;
  endsAt: number;
};

function describeGame(view: GameView, gameId: number): ActiveGame {
  const [t1, t2] = view.teams;
  if (!t1 || !t2) throw new Error("expected two teams");
  const finals = view.tasks.filter((t) => t.isFinal);
  if (finals.length !== 1 || !finals[0]) throw new Error("expected exactly one final task");
  return {
    code: view.game.code,
    gameId,
    view,
    teamIds: [t1.id, t2.id],
    taskIds: view.tasks.filter((t) => !t.isFinal).map((t) => t.id),
    finalTaskId: finals[0].id,
    startedAt: view.game.startedAt ?? -1,
    endsAt: view.game.endsAt ?? -1,
  };
}

/** Create, roll and start a game at the current injected time. Needs seedRollCatalog(). */
export async function activeGame(api: Api): Promise<ActiveGame> {
  const created = await createGame(api);
  await rollGame(api, created.game.code);
  const view = await startGame(api, created.game.code);
  return describeGame(view, (await gameRow(created.game.code)).id);
}

/** A rolled (not started) game. Needs seedRollCatalog(). */
export async function rolledGame(api: Api): Promise<ActiveGame> {
  const created = await createGame(api);
  const view = await rollGame(api, created.game.code);
  return describeGame(view, (await gameRow(created.game.code)).id);
}

export async function completeAllNonFinal(api: Api, g: ActiveGame, teamId: number): Promise<GameView> {
  let last: GameView | undefined;
  for (const taskId of g.taskIds) last = await readView(await complete(api, g.code, taskId, teamId));
  if (!last) throw new Error("no non-final tasks");
  return last;
}

export type Status = "setup" | "rolled" | "active" | "finished" | "abandoned";

/**
 * A game in `status`, reached through the API. "finished" is a completion win by slot 1.
 * Needs seedRollCatalog() for every status but setup and abandoned.
 */
export async function gameIn(api: Api, status: Status): Promise<{ code: string; gameId: number }> {
  if (status === "setup" || status === "abandoned") {
    const { game } = await createGame(api);
    if (status === "abandoned") await readView(await abandon(api, game.code));
    return { code: game.code, gameId: (await gameRow(game.code)).id };
  }
  if (status === "rolled") return rolledGame(api);
  const g = await activeGame(api);
  if (status === "finished") {
    await completeAllNonFinal(api, g, g.teamIds[0]);
    await readView(await complete(api, g.code, g.finalTaskId, g.teamIds[0]));
  }
  return g;
}

// ---------------------------------------------------------------------------
// D1 reads
// ---------------------------------------------------------------------------

export type GameDbRow = {
  id: number;
  code: string;
  status: string;
  is_test: number;
  version: number;
  created_at: number;
  rolled_at: number | null;
  started_at: number | null;
  ends_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
  winner_team_id: number | null;
};

export type TeamTaskDbRow = { team_id: number; game_task_id: number; completed_at: number | null };
export type EventDbRow = { id: number; game_id: number; team_id: number; game_task_id: number; action: string; at: number };

export async function gameRow(code: string): Promise<GameDbRow> {
  const row = await env.DB.prepare("SELECT * FROM games WHERE code = ?").bind(code).first<GameDbRow>();
  if (!row) throw new Error(`gameRow: no game with code ${code}`);
  return row;
}

export async function gameCount(): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM games").first<{ n: number }>())?.n ?? -1;
}

export async function teamRows(gameId: number) {
  const { results } = await env.DB.prepare("SELECT id, game_id, slot, name FROM teams WHERE game_id = ? ORDER BY slot")
    .bind(gameId)
    .all<{ id: number; game_id: number; slot: number; name: string }>();
  return results;
}

export async function gameTaskRows(gameId: number) {
  const { results } = await env.DB.prepare(
    "SELECT id, game_id, catalog_task_id, category_id, text, sort_order, is_final FROM game_tasks WHERE game_id = ? ORDER BY sort_order",
  )
    .bind(gameId)
    .all<{
      id: number;
      game_id: number;
      catalog_task_id: string;
      category_id: string;
      text: string;
      sort_order: number;
      is_final: number;
    }>();
  return results;
}

export async function teamTaskRows(gameId: number): Promise<TeamTaskDbRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT tt.team_id, tt.game_task_id, tt.completed_at
       FROM team_tasks tt JOIN teams t ON t.id = tt.team_id
      WHERE t.game_id = ?
      ORDER BY tt.team_id, tt.game_task_id`,
  )
    .bind(gameId)
    .all<TeamTaskDbRow>();
  return results;
}

export async function eventRows(gameId: number): Promise<EventDbRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM task_events WHERE game_id = ? ORDER BY id")
    .bind(gameId)
    .all<EventDbRow>();
  return results;
}

export async function eventCount(gameId: number): Promise<number> {
  return (await eventRows(gameId)).length;
}

/** Every row that belongs to one game, for "nothing was written" assertions. */
export async function gameState(gameId: number) {
  const game = await env.DB.prepare("SELECT * FROM games WHERE id = ?").bind(gameId).first<GameDbRow>();
  return {
    game,
    teams: await teamRows(gameId),
    gameTasks: await gameTaskRows(gameId),
    teamTasks: await teamTaskRows(gameId),
    events: await eventRows(gameId),
  };
}

/** The view's completedAt pair for one task. */
export function completedAt(view: GameView, taskId: number): [number | null, number | null] {
  const t = view.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error(`task ${taskId} not in view`);
  return t.completedAt;
}

export function teamView(view: GameView, slot: 1 | 2): TeamView {
  const t = view.teams.find((x) => x.slot === slot);
  if (!t) throw new Error(`team slot ${slot} not in view`);
  return t;
}
