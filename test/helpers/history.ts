// Shared helpers for the M5 history and records tests (SPEC.md §4 sweep, §8, §9, §10).
// Games are played through the API with the injected clock (makeDeps().setNow/advance),
// or bulk-inserted with parameterized SQL that respects the §8 end-state triggers.
// Nothing here depends on wall-clock time.
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { CODE_ALPHABET } from "../../src/worker/game/constants";
import type { makeDeps } from "./auth";
import {
  abandon,
  complete,
  gameRow,
  gameUrl,
  readView,
  undo,
  type ActiveGame,
  type Api,
  type GameView,
} from "./game";

export const MIN = 60_000;
export const HOUR = 60 * MIN;

export type Clock = ReturnType<typeof makeDeps>;

// ---------------------------------------------------------------------------
// Response shapes (test-side copies of the approved M5 plan; the client types are
// checked against the Worker in client-history-contract.test.ts)
// ---------------------------------------------------------------------------

export type RecordHolderBody = { code: string; teamName: string; ms: number; endedAt: number };

export type ListItemBody = {
  code: string;
  status: "finished" | "abandoned";
  startedAt: number | null;
  endedAt: number | null;
  elapsedMs: number | null;
  endReason: "completed" | "timeout" | null;
  winnerTeamId: number | null;
  teams: Array<{ id: number; slot: 1 | 2; name: string; score: number }>;
};

export type ListBody = {
  items: ListItemBody[];
  hasMore: boolean;
  records: { fastestWin: RecordHolderBody | null; fastestPuzzle: RecordHolderBody | null; gamesPlayed: number };
};

export type DetailBody = {
  game: {
    code: string;
    status: string;
    createdAt: number;
    startedAt: number | null;
    endsAt: number | null;
    endedAt: number | null;
    endReason: "completed" | "timeout" | null;
    winnerTeamId: number | null;
    elapsedMs: number | null;
  };
  teams: Array<{ id: number; slot: 1 | 2; name: string; score: number; puzzleMs: number | null }>;
  tasks: Array<{
    id: number;
    sortOrder: number;
    categoryName: string;
    text: string;
    isFinal: boolean;
    splitMs: (number | null)[];
  }>;
  events: Array<{
    id: number;
    at: number;
    sinceStartMs: number | null;
    teamId: number;
    taskId: number;
    action: "complete" | "undo";
  }>;
};

export const historyUrl = (code?: string) => (code === undefined ? "/api/history" : `/api/history/${code}`);

async function readJson<T>(res: Response, status: number): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

/** GET /api/history, asserting 200. */
export async function getList(api: Api): Promise<ListBody> {
  return readJson<ListBody>(await api.get(historyUrl()), 200);
}

/** GET /api/history/:code, asserting 200. */
export async function getDetail(api: Api, code: string): Promise<DetailBody> {
  return readJson<DetailBody>(await api.get(historyUrl(code)), 200);
}

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

/** Marks a game as a test game, the way the M6 admin toggle will. */
export async function markTest(code: string): Promise<void> {
  await env.DB.prepare("UPDATE games SET is_test = 1 WHERE code = ?").bind(code).run();
}

/** Version per code, for "nothing was bumped" assertions. */
export async function versions(codes: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const code of codes) out[code] = (await gameRow(code)).version;
  return out;
}

// ---------------------------------------------------------------------------
// Games played through the API (needs seedRollCatalog())
// ---------------------------------------------------------------------------

export const NAMES: [string, string] = ["Reds", "Blues"];

function describeView(view: GameView, gameId: number): ActiveGame {
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

/** Creates a game at `at` (default: the clock's current time) and renames its teams. */
export async function namedGame(api: Api, clock: Clock, opts: { at?: number; names?: [string, string] } = {}) {
  if (opts.at !== undefined) clock.setNow(opts.at);
  const created = await readView(await api.post("/api/games"), 201);
  const [team1, team2] = opts.names ?? NAMES;
  await readView(await api.patch(gameUrl(created.game.code, "/teams"), { team1, team2 }));
  return { code: created.game.code, gameId: (await gameRow(created.game.code)).id };
}

/**
 * A started game: created at `at` (default now), rolled at +1 min, started at +2 min.
 * The clock is left at startedAt.
 */
export async function startedGame(
  api: Api,
  clock: Clock,
  opts: { at?: number; names?: [string, string] } = {},
): Promise<ActiveGame> {
  const { code, gameId } = await namedGame(api, clock, opts);
  clock.advance(MIN);
  await readView(await api.post(gameUrl(code, "/roll")));
  clock.advance(MIN);
  const view = await readView(await api.post(gameUrl(code, "/start")));
  return describeView(view, gameId);
}

/** A rolled (not started) game; created at `at`, rolled at +1 min. */
export async function rolledNamedGame(api: Api, clock: Clock, opts: { at?: number; names?: [string, string] } = {}) {
  const { code, gameId } = await namedGame(api, clock, opts);
  clock.advance(MIN);
  const view = await readView(await api.post(gameUrl(code, "/roll")));
  return { code, gameId, view };
}

/**
 * One action at startedAt + `min` minutes. `task` is an index into the non-final tasks,
 * or "final". `atMs` (absolute) overrides `min` when given.
 */
export type Step = { slot: 1 | 2; task: number | "final"; min: number; action?: "complete" | "undo"; atMs?: number };

export function taskIdOf(g: ActiveGame, task: number | "final"): number {
  if (task === "final") return g.finalTaskId;
  const id = g.taskIds[task];
  if (id === undefined) throw new Error(`no non-final task at index ${task}`);
  return id;
}

/** Plays `steps` in order, setting the clock for each one. Every step must succeed (200). */
export async function play(api: Api, clock: Clock, g: ActiveGame, steps: Step[]): Promise<GameView | undefined> {
  let last: GameView | undefined;
  for (const s of steps) {
    clock.setNow(s.atMs ?? g.startedAt + s.min * MIN);
    const run = s.action === "undo" ? undo : complete;
    last = await readView(await run(api, g.code, taskIdOf(g, s.task), g.teamIds[s.slot - 1]));
  }
  return last;
}

/**
 * The canonical "Reds 4 – 3 Blues" game (minutes after start):
 * Reds  task2 @3, task0 @5, task1 @10, undo task0 @12, redo task0 @20, final @30 (wins).
 * Blues task0 @6, task1 @11, task2 @25.
 * Reds' puzzle time is 30 − 20 = 10 min (the redo counts); without the undo it would be 20.
 */
export const REDS_BLUES_STEPS: Step[] = [
  { slot: 1, task: 2, min: 3 },
  { slot: 1, task: 0, min: 5 },
  { slot: 2, task: 0, min: 6 },
  { slot: 1, task: 1, min: 10 },
  { slot: 2, task: 1, min: 11 },
  { slot: 1, task: 0, min: 12, action: "undo" },
  { slot: 1, task: 0, min: 20 },
  { slot: 2, task: 2, min: 25 },
  { slot: 1, task: "final", min: 30 },
];

/** Plays REDS_BLUES_STEPS in a new game created at `at`. Ends at startedAt + 30 min. */
export async function redsBluesGame(api: Api, clock: Clock, at?: number): Promise<ActiveGame> {
  const g = await startedGame(api, clock, { at });
  await play(api, clock, g, REDS_BLUES_STEPS);
  return g;
}

/**
 * A completion win for `winnerSlot`: it does its non-final tasks at +1, +2, +3 min and
 * the final at `finalMin` (> 3).
 */
export async function finishedGame(
  api: Api,
  clock: Clock,
  opts: { at?: number; names?: [string, string]; winnerSlot?: 1 | 2; finalMin: number },
): Promise<ActiveGame> {
  const g = await startedGame(api, clock, opts);
  const slot = opts.winnerSlot ?? 1;
  await play(api, clock, g, [
    ...g.taskIds.map((_, i): Step => ({ slot, task: i, min: i + 1 })),
    { slot, task: "final", min: opts.finalMin },
  ]);
  return g;
}

/** An active game with `steps` played, left unfinalized. The caller moves the clock past endsAt. */
export async function expiredGame(
  api: Api,
  clock: Clock,
  opts: { at?: number; names?: [string, string]; steps?: Step[] } = {},
): Promise<ActiveGame> {
  const g = await startedGame(api, clock, opts);
  await play(api, clock, g, opts.steps ?? []);
  return g;
}

/** A game finished by timeout: `steps`, then a GET at ends_at finalizes it. Clock left at endsAt. */
export async function timedOutGame(
  api: Api,
  clock: Clock,
  opts: { at?: number; names?: [string, string]; steps?: Step[] } = {},
): Promise<ActiveGame> {
  const g = await expiredGame(api, clock, opts);
  clock.setNow(g.endsAt);
  const view = await readView(await api.get(gameUrl(g.code)));
  expect(view.game).toMatchObject({ status: "finished", endReason: "timeout" });
  return g;
}

/** Abandons a game at the clock's current time. */
export async function abandonNow(api: Api, code: string): Promise<GameView> {
  return readView(await abandon(api, code));
}

// ---------------------------------------------------------------------------
// Bulk inserts (fast, direct parameterized SQL)
// ---------------------------------------------------------------------------

/** A distinct valid game code for bulk row `i` (0 ≤ i < 31^4), always starting with "Z". */
export function bulkCode(i: number): string {
  let n = i;
  let out = "";
  for (let k = 0; k < 4; k++) {
    out = CODE_ALPHABET[n % CODE_ALPHABET.length] + out;
    n = Math.floor(n / CODE_ALPHABET.length);
  }
  return `Z${out}`;
}

export type BulkGame = {
  code: string;
  status?: "finished" | "abandoned";
  isTest?: boolean;
  createdAt?: number;
  startedAt: number;
  endedAt: number;
  /** Finished games only; default "completed". */
  endReason?: "completed" | "timeout";
  /** Finished games only; default 1 for "completed", null (a tie) for "timeout". */
  winnerSlot?: 1 | 2 | null;
  names?: [string, string];
  /**
   * Adds two game tasks (catalog "drinks-a" and the final "puzzle-a"; needs
   * seedRollCatalog()) and team_tasks for both teams. `puzzleSlot` has drinks-a done at
   * `lastNonFinalAt` and the final at `finalAt`; the other team has nothing done.
   */
  puzzle?: { slot: 1 | 2; lastNonFinalAt: number; finalAt: number };
};

/**
 * Inserts finished/abandoned games in one batch. Each finished game is inserted with
 * its end_reason (the §8 trigger requires one) and no winner, then its teams, then the
 * winner is set by slot. Every value is bound.
 */
export async function insertHistoryGames(games: BulkGame[]): Promise<void> {
  const db = env.DB;
  const stmts: D1PreparedStatement[] = [];
  for (const g of games) {
    const status = g.status ?? "finished";
    const endReason = status === "finished" ? (g.endReason ?? "completed") : null;
    const winnerSlot = status !== "finished" ? null : g.winnerSlot !== undefined ? g.winnerSlot : endReason === "completed" ? 1 : null;
    const [n1, n2] = g.names ?? NAMES;
    const createdAt = g.createdAt ?? g.startedAt - 2 * MIN;
    stmts.push(
      db
        .prepare(
          `INSERT INTO games (code, status, is_test, version, created_at, rolled_at, started_at, ends_at, ended_at, end_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(g.code, status, g.isTest ? 1 : 0, 5, createdAt, createdAt + MIN, g.startedAt, g.startedAt + HOUR, g.endedAt, endReason),
      db.prepare("INSERT INTO teams (game_id, slot, name) SELECT id, 1, ? FROM games WHERE code = ?").bind(n1, g.code),
      db.prepare("INSERT INTO teams (game_id, slot, name) SELECT id, 2, ? FROM games WHERE code = ?").bind(n2, g.code),
    );
    if (winnerSlot !== null) {
      stmts.push(
        db
          .prepare(
            `UPDATE games SET winner_team_id = (SELECT t.id FROM teams t WHERE t.game_id = games.id AND t.slot = ?)
             WHERE code = ?`,
          )
          .bind(winnerSlot, g.code),
      );
    }
    if (g.puzzle) {
      const p = g.puzzle;
      stmts.push(
        db
          .prepare(
            `INSERT INTO game_tasks (game_id, catalog_task_id, category_id, text, sort_order, is_final)
             SELECT id, 'drinks-a', 'drinks', 'Drink A', 1, 0 FROM games WHERE code = ?`,
          )
          .bind(g.code),
        db
          .prepare(
            `INSERT INTO game_tasks (game_id, catalog_task_id, category_id, text, sort_order, is_final)
             SELECT id, 'puzzle-a', 'puzzle', 'Puzzle A', 2, 1 FROM games WHERE code = ?`,
          )
          .bind(g.code),
        db
          .prepare(
            `INSERT INTO team_tasks (team_id, game_task_id, completed_at)
             SELECT t.id, gt.id,
                    CASE WHEN t.slot = ? THEN (CASE WHEN gt.is_final = 1 THEN ? ELSE ? END) ELSE NULL END
               FROM games g JOIN teams t ON t.game_id = g.id JOIN game_tasks gt ON gt.game_id = g.id
              WHERE g.code = ?`,
          )
          .bind(p.slot, p.finalAt, p.lastNonFinalAt, g.code),
      );
    }
  }
  await env.DB.batch(stmts);
}
