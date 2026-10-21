// Shared D1 helpers for the M2 tests (SPEC.md §7, §8).
// Every statement that carries a value is prepared and bound; nothing is interpolated.
import { env } from "cloudflare:workers";

/** Fixed test clock: 2026-10-20T12:00:00Z in UTC epoch ms. */
export const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
export const MINUTE = 60_000;

export type Row = Record<string, unknown>;

/**
 * Clears every table, children first. `winner_team_id` is nulled before teams go,
 * because there is no ON DELETE CASCADE and foreign keys are enforced.
 */
export async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE games SET winner_team_id = NULL"),
    env.DB.prepare("DELETE FROM task_events"),
    env.DB.prepare("DELETE FROM team_tasks"),
    env.DB.prepare("DELETE FROM game_tasks"),
    env.DB.prepare("DELETE FROM teams"),
    env.DB.prepare("DELETE FROM games"),
    env.DB.prepare("DELETE FROM catalog_tasks"),
    env.DB.prepare("DELETE FROM categories"),
  ]);
}

/**
 * D1's `exec` rejects a line that holds only a SQL comment, so the header comment
 * line(s) of the generated sync SQL are dropped before executing. Every other line
 * runs exactly as generated.
 */
export function execableSql(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("--"))
    .join("\n");
}

export async function snapshotCatalog(): Promise<{ categories: Row[]; tasks: Row[] }> {
  const [cats, tasks] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM categories ORDER BY id"),
    env.DB.prepare("SELECT * FROM catalog_tasks ORDER BY id"),
  ]);
  return { categories: cats?.results as Row[], tasks: tasks?.results as Row[] };
}

export async function insertCategory(
  id: string,
  opts: { name?: string; sortOrder: number; countPerGame?: number; isFinal?: 0 | 1 },
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO categories (id, name, sort_order, count_per_game, is_final) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, opts.name ?? `Category ${id}`, opts.sortOrder, opts.countPerGame ?? 1, opts.isFinal ?? 0)
    .run();
}

export async function insertCatalogTask(id: string, categoryId: string, text = `Task ${id}`): Promise<void> {
  await env.DB.prepare("INSERT INTO catalog_tasks (id, category_id, text) VALUES (?, ?, ?)")
    .bind(id, categoryId, text)
    .run();
}

/** A tiny catalog in D1: one normal category with two tasks and a final category with one. */
export async function seedMiniCatalog(): Promise<void> {
  await insertCategory("cat-a", { sortOrder: 1, countPerGame: 2 });
  await insertCategory("cat-final", { sortOrder: 2, countPerGame: 1, isFinal: 1 });
  await insertCatalogTask("task-a1", "cat-a");
  await insertCatalogTask("task-a2", "cat-a");
  await insertCatalogTask("task-final", "cat-final");
}

export type SeedTask = { catalogTaskId: string; categoryId: string; text: string; isFinal: 0 | 1 };

export const MINI_GAME_TASKS: SeedTask[] = [
  { catalogTaskId: "task-a1", categoryId: "cat-a", text: "Task task-a1", isFinal: 0 },
  { catalogTaskId: "task-a2", categoryId: "cat-a", text: "Task task-a2", isFinal: 0 },
  { catalogTaskId: "task-final", categoryId: "cat-final", text: "Task task-final", isFinal: 1 },
];

export async function insertGame(code: string, createdAt = T0): Promise<number> {
  const row = await env.DB.prepare("INSERT INTO games (code, created_at) VALUES (?, ?) RETURNING id")
    .bind(code, createdAt)
    .first<{ id: number }>();
  if (!row) throw new Error("insertGame: no id returned");
  return row.id;
}

export async function insertTeam(gameId: number, slot: number, name: string): Promise<number> {
  const row = await env.DB.prepare("INSERT INTO teams (game_id, slot, name) VALUES (?, ?, ?) RETURNING id")
    .bind(gameId, slot, name)
    .first<{ id: number }>();
  if (!row) throw new Error("insertTeam: no id returned");
  return row.id;
}

export async function insertGameTask(gameId: number, t: SeedTask, sortOrder: number): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO game_tasks (game_id, catalog_task_id, category_id, text, sort_order, is_final) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
  )
    .bind(gameId, t.catalogTaskId, t.categoryId, t.text, sortOrder, t.isFinal)
    .first<{ id: number }>();
  if (!row) throw new Error("insertGameTask: no id returned");
  return row.id;
}

export type SeededGame = { gameId: number; teamIds: [number, number]; gameTaskIds: number[] };

/**
 * A finished game with every kind of child row: two teams, game_tasks, team_tasks
 * for both teams, task_events (including an undo), and a winner.
 */
export async function seedFullGame(code: string, tasks: SeedTask[] = MINI_GAME_TASKS): Promise<SeededGame> {
  const gameId = await insertGame(code);
  await env.DB.prepare("UPDATE games SET status = ?, rolled_at = ?, started_at = ?, ends_at = ? WHERE id = ?")
    .bind("active", T0 + MINUTE, T0 + 2 * MINUTE, T0 + 62 * MINUTE, gameId)
    .run();
  const teamIds: [number, number] = [await insertTeam(gameId, 1, "Team One"), await insertTeam(gameId, 2, "Team Two")];
  const gameTaskIds: number[] = [];
  for (const [i, t] of tasks.entries()) gameTaskIds.push(await insertGameTask(gameId, t, i + 1));

  const stmts: D1PreparedStatement[] = [];
  for (const teamId of teamIds) {
    for (const gtId of gameTaskIds) {
      stmts.push(
        env.DB.prepare("INSERT INTO team_tasks (team_id, game_task_id, completed_at) VALUES (?, ?, ?)").bind(
          teamId,
          gtId,
          teamId === teamIds[0] ? T0 + 10 * MINUTE : null,
        ),
      );
    }
  }
  const firstTask = gameTaskIds[0] as number;
  stmts.push(
    env.DB.prepare("INSERT INTO task_events (game_id, team_id, game_task_id, action, at) VALUES (?, ?, ?, ?, ?)").bind(
      gameId,
      teamIds[1],
      firstTask,
      "complete",
      T0 + 5 * MINUTE,
    ),
    env.DB.prepare("INSERT INTO task_events (game_id, team_id, game_task_id, action, at) VALUES (?, ?, ?, ?, ?)").bind(
      gameId,
      teamIds[1],
      firstTask,
      "undo",
      T0 + 6 * MINUTE,
    ),
    env.DB.prepare("INSERT INTO task_events (game_id, team_id, game_task_id, action, at) VALUES (?, ?, ?, ?, ?)").bind(
      gameId,
      teamIds[0],
      firstTask,
      "complete",
      T0 + 10 * MINUTE,
    ),
    env.DB.prepare(
      "UPDATE games SET status = ?, end_reason = ?, ended_at = ?, winner_team_id = ? WHERE id = ?",
    ).bind("finished", "completed", T0 + 10 * MINUTE, teamIds[0], gameId),
  );
  await env.DB.batch(stmts);
  return { gameId, teamIds, gameTaskIds };
}

/** Row counts for one game across every table that belongs to it. */
export async function gameRowCounts(gameId: number): Promise<Record<string, number>> {
  const q = (sql: string) => env.DB.prepare(sql).bind(gameId);
  const results = await env.DB.batch<{ n: number }>([
    q("SELECT COUNT(*) AS n FROM games WHERE id = ?"),
    q("SELECT COUNT(*) AS n FROM teams WHERE game_id = ?"),
    q("SELECT COUNT(*) AS n FROM game_tasks WHERE game_id = ?"),
    q("SELECT COUNT(*) AS n FROM team_tasks WHERE game_task_id IN (SELECT id FROM game_tasks WHERE game_id = ?)"),
    q("SELECT COUNT(*) AS n FROM task_events WHERE game_id = ?"),
  ]);
  const n = (i: number) => results[i]?.results[0]?.n ?? -1;
  return { games: n(0), teams: n(1), game_tasks: n(2), team_tasks: n(3), task_events: n(4) };
}

/**
 * SPEC.md §8: deleting a game is one batch, in the order Bob approved
 * (no ON DELETE CASCADE).
 */
export function deleteGameBatch(gameId: number): D1PreparedStatement[] {
  return [
    env.DB.prepare("UPDATE games SET winner_team_id = NULL WHERE id = ?").bind(gameId),
    env.DB.prepare("DELETE FROM task_events WHERE game_id = ?").bind(gameId),
    env.DB.prepare("DELETE FROM team_tasks WHERE team_id IN (SELECT id FROM teams WHERE game_id = ?)").bind(gameId),
    env.DB.prepare("DELETE FROM game_tasks WHERE game_id = ?").bind(gameId),
    env.DB.prepare("DELETE FROM teams WHERE game_id = ?").bind(gameId),
    env.DB.prepare("DELETE FROM games WHERE id = ?").bind(gameId),
  ];
}
