// Read-only history queries (SPEC.md §9). Test games are hidden entirely.
import type { HistoryGame, HistoryTeam } from "../game/records";

type Row = Record<string, unknown>;
const numOrNull = (v: unknown) => (v === null ? null : (v as number));

const OVER = "is_test = 0 AND status IN ('finished', 'abandoned')";

/** Every finished or abandoned non-test game, newest first, with per-team totals. */
export async function readHistoryGames(db: D1Database): Promise<HistoryGame[]> {
  const [games, teams] = await db.batch<Row>([
    db.prepare(
      `SELECT id, code, status, started_at, ended_at, end_reason, winner_team_id
       FROM games WHERE ${OVER} ORDER BY ended_at DESC, id DESC`,
    ),
    db.prepare(
      `SELECT t.game_id, t.id, t.slot, t.name,
              COUNT(tt.completed_at) AS score,
              MAX(CASE WHEN gt.is_final = 0 THEN tt.completed_at END) AS last_non_final_at,
              MAX(CASE WHEN gt.is_final = 1 THEN tt.completed_at END) AS final_at
       FROM teams t
       JOIN games g ON g.id = t.game_id
       LEFT JOIN team_tasks tt ON tt.team_id = t.id
       LEFT JOIN game_tasks gt ON gt.id = tt.game_task_id
       WHERE g.is_test = 0 AND g.status IN ('finished', 'abandoned')
       GROUP BY t.id
       ORDER BY t.game_id, t.slot`,
    ),
  ]);

  const teamsByGame = new Map<number, HistoryTeam[]>();
  for (const t of teams!.results) {
    const list = teamsByGame.get(t.game_id as number) ?? [];
    list.push({
      id: t.id as number,
      slot: t.slot as 1 | 2,
      name: t.name as string,
      score: t.score as number,
      lastNonFinalAt: numOrNull(t.last_non_final_at),
      finalAt: numOrNull(t.final_at),
    });
    teamsByGame.set(t.game_id as number, list);
  }

  return games!.results.map((g) => ({
    code: g.code as string,
    status: g.status as "finished" | "abandoned",
    isTest: false,
    startedAt: numOrNull(g.started_at),
    endedAt: numOrNull(g.ended_at),
    endReason: g.end_reason as "completed" | "timeout" | null,
    winnerTeamId: numOrNull(g.winner_team_id),
    teams: teamsByGame.get(g.id as number) ?? [],
  }));
}

/** True when the code names a finished or abandoned non-test game. */
export async function isHistoryGame(db: D1Database, code: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 FROM games WHERE code = ? AND ${OVER}`).bind(code).first();
  return row !== null;
}

export type EventRow = { id: number; teamId: number; gameTaskId: number; action: "complete" | "undo"; at: number };

export async function readEvents(db: D1Database, gameId: number): Promise<EventRow[]> {
  const { results } = await db
    .prepare("SELECT id, team_id, game_task_id, action, at FROM task_events WHERE game_id = ? ORDER BY at, id")
    .bind(gameId)
    .all<Row>();
  return results.map((e) => ({
    id: e.id as number,
    teamId: e.team_id as number,
    gameTaskId: e.game_task_id as number,
    action: e.action as "complete" | "undo",
    at: e.at as number,
  }));
}
