// Admin reads and writes (SPEC.md §7, §8, §9). Parameterized SQL only.
import type { GameStatus } from "../game/types";

type Row = Record<string, unknown>;
const numOrNull = (v: unknown) => (v === null ? null : (v as number));

export type AdminGameRow = {
  code: string;
  status: GameStatus;
  isTest: boolean;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  endReason: "completed" | "timeout" | null;
  winnerTeamId: number | null;
  teams: { id: number; slot: 1 | 2; name: string; score: number }[];
};

/** Every game (test and in-progress included), newest first; or just `code`. */
export async function readAdminGames(db: D1Database, code?: string): Promise<AdminGameRow[]> {
  const where = code === undefined ? "" : "WHERE g.code = ?";
  const params = code === undefined ? [] : [code];
  const [games, teams] = await db.batch<Row>([
    db
      .prepare(
        `SELECT g.id, g.code, g.status, g.is_test, g.created_at, g.started_at, g.ended_at, g.end_reason, g.winner_team_id
         FROM games g ${where} ORDER BY g.created_at DESC, g.id DESC`,
      )
      .bind(...params),
    db
      .prepare(
        `SELECT t.game_id, t.id, t.slot, t.name, COUNT(tt.completed_at) AS score
         FROM teams t JOIN games g ON g.id = t.game_id
         LEFT JOIN team_tasks tt ON tt.team_id = t.id
         ${where}
         GROUP BY t.id ORDER BY t.game_id, t.slot`,
      )
      .bind(...params),
  ]);

  const teamsByGame = new Map<number, AdminGameRow["teams"]>();
  for (const t of teams!.results) {
    const list = teamsByGame.get(t.game_id as number) ?? [];
    list.push({ id: t.id as number, slot: t.slot as 1 | 2, name: t.name as string, score: t.score as number });
    teamsByGame.set(t.game_id as number, list);
  }

  return games!.results.map((g) => ({
    code: g.code as string,
    status: g.status as GameStatus,
    isTest: g.is_test === 1,
    createdAt: g.created_at as number,
    startedAt: numOrNull(g.started_at),
    endedAt: numOrNull(g.ended_at),
    endReason: g.end_reason as "completed" | "timeout" | null,
    winnerTeamId: numOrNull(g.winner_team_id),
    teams: teamsByGame.get(g.id as number) ?? [],
  }));
}

/**
 * Hides a game from history and records, or shows it again. Deliberately leaves
 * `version` alone: players' phones show nothing that depends on it.
 */
export async function setTestFlag(db: D1Database, code: string, isTest: boolean): Promise<boolean> {
  const result = await db.prepare("UPDATE games SET is_test = ? WHERE code = ?").bind(isTest ? 1 : 0, code).run();
  return result.meta.changes === 1;
}

/**
 * Permanently deletes a game and all its rows in one batch, in the SPEC.md §8 order.
 * Every statement finds the game by code, so there's no gap between lookup and delete.
 * Returns false if there was no such game.
 */
export async function deleteGame(db: D1Database, code: string): Promise<boolean> {
  const gameId = "(SELECT id FROM games WHERE code = ?)";
  const results = await db.batch([
    db.prepare("UPDATE games SET winner_team_id = NULL WHERE code = ?").bind(code),
    db.prepare(`DELETE FROM task_events WHERE game_id = ${gameId}`).bind(code),
    db.prepare(`DELETE FROM team_tasks WHERE team_id IN (SELECT id FROM teams WHERE game_id = ${gameId})`).bind(code),
    db.prepare(`DELETE FROM game_tasks WHERE game_id = ${gameId}`).bind(code),
    db.prepare(`DELETE FROM teams WHERE game_id = ${gameId}`).bind(code),
    db.prepare("DELETE FROM games WHERE code = ?").bind(code),
  ]);
  return results.at(-1)!.meta.changes === 1;
}

export type CatalogRows = {
  categories: { id: string; name: string; sortOrder: number; countPerGame: number; isFinal: boolean; active: boolean }[];
  tasks: { id: string; categoryId: string; text: string; active: boolean }[];
};

/** Every category and task, retired ones included (SPEC.md §7: shown read-only). */
export async function readFullCatalog(db: D1Database): Promise<CatalogRows> {
  const [categories, tasks] = await db.batch<Row>([
    db.prepare("SELECT id, name, sort_order, count_per_game, is_final, active FROM categories ORDER BY active DESC, sort_order, id"),
    db.prepare("SELECT id, category_id, text, active FROM catalog_tasks ORDER BY id"),
  ]);
  return {
    categories: categories!.results.map((c) => ({
      id: c.id as string,
      name: c.name as string,
      sortOrder: c.sort_order as number,
      countPerGame: c.count_per_game as number,
      isFinal: c.is_final === 1,
      active: c.active === 1,
    })),
    tasks: tasks!.results.map((t) => ({
      id: t.id as string,
      categoryId: t.category_id as string,
      text: t.text as string,
      active: t.active === 1,
    })),
  };
}
