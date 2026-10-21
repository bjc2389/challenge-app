// The JSON the history endpoints return (SPEC.md §9, §10).
import type { EventRow } from "../db/history";
import { scoreFor } from "../game/lock";
import { computeRecords, elapsedMs, puzzleMs, splitMs, type HistoryGame } from "../game/records";
import type { Snapshot } from "../game/types";

/** A prototype-sized list; records still cover every game. */
export const HISTORY_LIMIT = 25;

/** `games` is every finished or abandoned non-test game, newest first. */
export function toHistoryList(games: HistoryGame[]) {
  return {
    items: games.slice(0, HISTORY_LIMIT).map((g) => ({
      code: g.code,
      status: g.status,
      startedAt: g.startedAt,
      endedAt: g.endedAt,
      elapsedMs: elapsedMs(g),
      endReason: g.endReason,
      winnerTeamId: g.winnerTeamId,
      teams: g.teams.map((t) => ({ id: t.id, slot: t.slot, name: t.name, score: t.score })),
    })),
    hasMore: games.length > HISTORY_LIMIT,
    records: computeRecords(games),
  };
}

export function toHistoryDetail(snap: Snapshot, events: EventRow[]) {
  const { game, teams, tasks, teamTasks } = snap;
  const completedAt = (teamId: number, gameTaskId: number) =>
    teamTasks.find((tt) => tt.teamId === teamId && tt.gameTaskId === gameTaskId)?.completedAt ?? null;
  const finalTask = tasks.find((t) => t.isFinal);

  return {
    game: {
      code: game.code,
      status: game.status,
      createdAt: game.createdAt,
      startedAt: game.startedAt,
      endsAt: game.endsAt,
      endedAt: game.endedAt,
      endReason: game.endReason,
      winnerTeamId: game.winnerTeamId,
      elapsedMs: elapsedMs(game),
    },
    teams: teams.map((team) => {
      const nonFinal = tasks
        .filter((t) => !t.isFinal)
        .flatMap((t) => {
          const at = completedAt(team.id, t.id);
          return at === null ? [] : [at];
        });
      return {
        id: team.id,
        slot: team.slot,
        name: team.name,
        score: scoreFor(teamTasks, team.id),
        puzzleMs: puzzleMs(
          {
            id: team.id,
            slot: team.slot,
            name: team.name,
            score: 0,
            lastNonFinalAt: nonFinal.length > 0 ? Math.max(...nonFinal) : null,
            finalAt: finalTask ? completedAt(team.id, finalTask.id) : null,
          },
          game.startedAt,
        ),
      };
    }),
    tasks: tasks.map((task) => ({
      id: task.id,
      sortOrder: task.sortOrder,
      categoryName: task.categoryName,
      text: task.text,
      isFinal: task.isFinal,
      // Aligned with `teams`: index 0 is slot 1. Undone tasks are null.
      splitMs: teams.map((team) => splitMs(game.startedAt, completedAt(team.id, task.id))),
    })),
    events: events.map((e) => ({
      id: e.id,
      at: e.at,
      sinceStartMs: splitMs(game.startedAt, e.at),
      teamId: e.teamId,
      taskId: e.gameTaskId,
      action: e.action,
    })),
  };
}
