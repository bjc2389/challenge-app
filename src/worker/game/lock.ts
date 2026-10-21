import type { GameTaskRow, TeamTaskRow } from "./types";

const isDone = (teamTasks: TeamTaskRow[], teamId: number, gameTaskId: number) =>
  teamTasks.some((tt) => tt.teamId === teamId && tt.gameTaskId === gameTaskId && tt.completedAt !== null);

// SPEC.md §5: the final task unlocks for a team once all its other tasks are complete.
export function isFinalUnlocked(tasks: GameTaskRow[], teamTasks: TeamTaskRow[], teamId: number): boolean {
  return tasks.filter((t) => !t.isFinal).every((t) => isDone(teamTasks, teamId, t.id));
}

export function scoreFor(teamTasks: TeamTaskRow[], teamId: number): number {
  return teamTasks.filter((tt) => tt.teamId === teamId && tt.completedAt !== null).length;
}
