import { GAME_DURATION_MS } from "../game/constants";
import { isFinalUnlocked, scoreFor } from "../game/lock";
import type { Snapshot } from "../game/types";

// The JSON every game endpoint returns (SPEC.md §6, §10). `serverNow` lets the
// client correct for clock drift; `version` lets it skip redraws.
export function toGameView(snap: Snapshot, now: number) {
  const { game, teams, tasks, teamTasks } = snap;
  const completedAt = (teamId: number, gameTaskId: number) =>
    teamTasks.find((tt) => tt.teamId === teamId && tt.gameTaskId === gameTaskId)?.completedAt ?? null;

  return {
    serverNow: now,
    version: game.version,
    game: {
      code: game.code,
      status: game.status,
      createdAt: game.createdAt,
      rolledAt: game.rolledAt,
      startedAt: game.startedAt,
      endsAt: game.endsAt,
      endedAt: game.endedAt,
      endReason: game.endReason,
      winnerTeamId: game.winnerTeamId,
      durationMs: GAME_DURATION_MS,
    },
    teams: teams.map((team) => {
      const done = teamTasks.flatMap((tt) => (tt.teamId === team.id && tt.completedAt !== null ? [tt.completedAt] : []));
      return {
        id: team.id,
        slot: team.slot,
        name: team.name,
        score: scoreFor(teamTasks, team.id),
        // Nothing is unlocked before the roll.
        finalUnlocked: tasks.length > 0 && isFinalUnlocked(tasks, teamTasks, team.id),
        lastCompletedAt: done.length > 0 ? Math.max(...done) : null,
      };
    }),
    tasks: tasks.map((task) => ({
      id: task.id,
      sortOrder: task.sortOrder,
      categoryId: task.categoryId,
      categoryName: task.categoryName,
      text: task.text,
      isFinal: task.isFinal,
      // Aligned with `teams`: index 0 is slot 1.
      completedAt: teams.map((team) => completedAt(team.id, task.id)),
    })),
  };
}
