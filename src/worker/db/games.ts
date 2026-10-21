// Game reads and writes (SPEC.md §4, §5, §8). Parameterized SQL only.
import { isExpired, timeoutWinner } from "../game/finalize";
import type { CatalogCategory, CatalogTask, Change, GameStatus, Snapshot } from "../game/types";

type Row = Record<string, unknown>;

const num = (v: unknown) => v as number;
const numOrNull = (v: unknown) => (v === null ? null : (v as number));

/** Loads one game by its normalized code, or null if there is none. */
export async function loadSnapshot(db: D1Database, code: string): Promise<Snapshot | null> {
  const g = await db.prepare("SELECT * FROM games WHERE code = ?").bind(code).first<Row>();
  if (!g) return null;
  const [teams, tasks, teamTasks] = await db.batch<Row>([
    db.prepare("SELECT id, slot, name FROM teams WHERE game_id = ? ORDER BY slot").bind(g.id),
    db
      .prepare(
        `SELECT gt.id, gt.catalog_task_id, gt.category_id, c.name AS category_name, gt.text, gt.sort_order, gt.is_final
         FROM game_tasks gt JOIN categories c ON c.id = gt.category_id
         WHERE gt.game_id = ? ORDER BY gt.sort_order`,
      )
      .bind(g.id),
    db
      .prepare(
        `SELECT tt.team_id, tt.game_task_id, tt.completed_at
         FROM team_tasks tt JOIN teams t ON t.id = tt.team_id WHERE t.game_id = ?`,
      )
      .bind(g.id),
  ]);
  return {
    game: {
      id: num(g.id),
      code: g.code as string,
      status: g.status as GameStatus,
      version: num(g.version),
      createdAt: num(g.created_at),
      rolledAt: numOrNull(g.rolled_at),
      startedAt: numOrNull(g.started_at),
      endsAt: numOrNull(g.ends_at),
      endedAt: numOrNull(g.ended_at),
      endReason: g.end_reason as "completed" | "timeout" | null,
      winnerTeamId: numOrNull(g.winner_team_id),
    },
    teams: teams!.results.map((t) => ({ id: num(t.id), slot: t.slot as 1 | 2, name: t.name as string })),
    tasks: tasks!.results.map((t) => ({
      id: num(t.id),
      catalogTaskId: t.catalog_task_id as string,
      categoryId: t.category_id as string,
      categoryName: t.category_name as string,
      text: t.text as string,
      sortOrder: num(t.sort_order),
      isFinal: t.is_final === 1,
    })),
    teamTasks: teamTasks!.results.map((t) => ({
      teamId: num(t.team_id),
      gameTaskId: num(t.game_task_id),
      completedAt: numOrNull(t.completed_at),
    })),
  };
}

/**
 * Creates a game in setup with its two default-named teams, in one batch.
 * Returns false (and writes nothing) if the code is already taken.
 */
export async function insertGame(db: D1Database, code: string, now: number, teamNames: readonly [string, string]) {
  const [game] = await db.batch([
    db.prepare("INSERT INTO games (code, created_at) VALUES (?, ?) ON CONFLICT (code) DO NOTHING").bind(code, now),
    // changes() is the row count of the statement just before this one, so on a code
    // collision (0 rows) no teams are added to the existing game.
    db
      .prepare(
        `INSERT INTO teams (game_id, slot, name)
         SELECT g.id, v.slot, v.name FROM games g, (SELECT 1 AS slot, ? AS name UNION ALL SELECT 2, ?) v
         WHERE g.code = ? AND changes() = 1`,
      )
      .bind(teamNames[0], teamNames[1], code),
  ]);
  return game!.meta.changes === 1;
}

/** Active categories and tasks, read at roll time (SPEC.md §5). */
export async function readActiveCatalog(db: D1Database): Promise<{ categories: CatalogCategory[]; tasks: CatalogTask[] }> {
  const [categories, tasks] = await db.batch<Row>([
    db.prepare("SELECT id, name, sort_order, count_per_game, is_final FROM categories WHERE active = 1"),
    db.prepare("SELECT id, category_id, text FROM catalog_tasks WHERE active = 1"),
  ]);
  return {
    categories: categories!.results.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      sortOrder: num(r.sort_order),
      countPerGame: num(r.count_per_game),
      isFinal: r.is_final === 1,
      active: true,
    })),
    tasks: tasks!.results.map((r) => ({
      id: r.id as string,
      categoryId: r.category_id as string,
      text: r.text as string,
      active: true,
    })),
  };
}

/** The statuses each change may be applied from, re-checked inside the batch. */
const FROM_STATUS: Record<Change["kind"], GameStatus[]> = {
  roll: ["setup"],
  rename: ["setup", "rolled"],
  start: ["rolled"],
  complete: ["active"],
  undo: ["active"],
  timeout: ["active"],
  abandon: ["setup", "rolled", "active"],
};

/**
 * Commits one change as a single D1 batch (one transaction). Every statement only
 * takes effect while the game still has `expectedVersion`, an allowed status and
 * (for player actions) time left; the last one bumps the version. Returns false,
 * having written nothing, if another write got there first. Throws, with nothing
 * written, if any statement fails.
 */
export async function commitChange(db: D1Database, gameId: number, expectedVersion: number, change: Change) {
  // Every statement carries the same condition as the final games UPDATE: version,
  // allowed status, and (for player actions) the deadline. So either all of them
  // apply or none do. The timeout itself has no `at` and is exempt from the deadline.
  const from = FROM_STATUS[change.kind];
  const deadline = "at" in change ? [change.at] : [];
  const condition =
    `id = ? AND version = ? AND status IN (${from.map(() => "?").join(", ")})` +
    (deadline.length > 0 ? " AND (ends_at IS NULL OR ends_at > ?)" : "");
  const conditionParams = [gameId, expectedVersion, ...from, ...deadline];
  const guarded = (sql: string, ...params: unknown[]) =>
    db.prepare(`${sql} AND EXISTS (SELECT 1 FROM games WHERE ${condition})`).bind(...params, ...conditionParams);
  const statements: D1PreparedStatement[] = [];
  let set: string[] = [];
  let setParams: unknown[] = [];

  switch (change.kind) {
    case "roll":
      for (const t of change.tasks) {
        statements.push(
          guarded(
            `INSERT INTO game_tasks (game_id, catalog_task_id, category_id, text, sort_order, is_final)
             SELECT ?, ?, ?, ?, ?, ? WHERE 1`,
            gameId,
            t.catalogTaskId,
            t.categoryId,
            t.text,
            t.sortOrder,
            t.isFinal ? 1 : 0,
          ),
        );
      }
      // One row per team per task, all not done.
      statements.push(
        guarded(
          `INSERT INTO team_tasks (team_id, game_task_id)
           SELECT t.id, gt.id FROM teams t JOIN game_tasks gt ON gt.game_id = t.game_id WHERE t.game_id = ?`,
          gameId,
        ),
      );
      set = ["status = 'rolled'", "rolled_at = ?"];
      setParams = [change.at];
      break;
    case "rename":
      change.names.forEach((name, i) => {
        statements.push(guarded("UPDATE teams SET name = ? WHERE game_id = ? AND slot = ?", name, gameId, i + 1));
      });
      break;
    case "start":
      set = ["status = 'active'", "started_at = ?", "ends_at = ?"];
      setParams = [change.at, change.endsAt];
      break;
    case "complete":
    case "undo":
      statements.push(
        guarded(
          `UPDATE team_tasks SET completed_at = ?
           WHERE team_id = ? AND game_task_id = ?
             AND team_id IN (SELECT id FROM teams WHERE game_id = ?)
             AND game_task_id IN (SELECT id FROM game_tasks WHERE game_id = ?)`,
          change.kind === "complete" ? change.at : null,
          change.teamId,
          change.gameTaskId,
          gameId,
          gameId,
        ),
        guarded(
          "INSERT INTO task_events (game_id, team_id, game_task_id, action, at) SELECT ?, ?, ?, ?, ? WHERE 1",
          gameId,
          change.teamId,
          change.gameTaskId,
          change.kind,
          change.at,
        ),
      );
      if (change.kind === "complete" && change.finish) {
        set = ["status = 'finished'", "end_reason = 'completed'", "ended_at = ?", "winner_team_id = ?"];
        setParams = [change.at, change.finish.winnerTeamId];
      }
      break;
    case "timeout":
      set = ["status = 'finished'", "end_reason = 'timeout'", "ended_at = ?", "winner_team_id = ?"];
      setParams = [change.endedAt, change.winnerTeamId];
      break;
    case "abandon":
      set = ["status = 'abandoned'", "ended_at = ?"];
      setParams = [change.at];
      break;
  }

  statements.push(
    db
      .prepare(`UPDATE games SET ${[...set, "version = version + 1"].join(", ")} WHERE ${condition}`)
      .bind(...setParams, ...conditionParams),
  );

  const results = await db.batch(statements);
  return results.at(-1)!.meta.changes === 1;
}

/**
 * SPEC.md §4: the first request touching an expired game finalizes it. Returns the
 * current snapshot, reloaded if anything may have changed.
 */
export async function finalizeIfExpired(db: D1Database, snap: Snapshot, now: number): Promise<Snapshot> {
  if (!isExpired(snap.game, now)) return snap;
  const winnerTeamId = timeoutWinner(
    snap.teams.map((team) => ({
      teamId: team.id,
      completedAts: snap.teamTasks.flatMap((tt) =>
        tt.teamId === team.id && tt.completedAt !== null ? [tt.completedAt] : [],
      ),
    })),
  );
  // If this loses a race, another request finalized it; either way reload.
  await commitChange(db, snap.game.id, snap.game.version, {
    kind: "timeout",
    endedAt: snap.game.endsAt!,
    winnerTeamId,
  });
  return (await loadSnapshot(db, snap.game.code)) ?? snap;
}
