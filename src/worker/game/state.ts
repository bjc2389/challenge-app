import { isFinalUnlocked } from "./lock";
import type { Decision, GameStatus, Snapshot } from "./types";

export type Action = "roll" | "renameTeams" | "start" | "complete" | "undo" | "abandon";

// SPEC.md §4: which actions each status allows. There is no re-rolling.
export const ALLOWED: Record<Action, GameStatus[]> = {
  roll: ["setup"],
  renameTeams: ["setup", "rolled"],
  start: ["rolled"],
  complete: ["active"],
  undo: ["active"],
  abandon: ["setup", "rolled", "active"],
};

export const canDo = (status: GameStatus, action: Action) => ALLOWED[action].includes(status);

const error = (status: 404 | 409 | 422, code: string, message: string): Decision => ({
  kind: "error",
  status,
  error: code,
  message,
});

/** The 409 for an action the current status doesn't allow. */
export function statusError(status: GameStatus): Decision {
  return status === "finished" || status === "abandoned"
    ? error(409, "game_over", "This game is over")
    : error(409, "invalid_state", "That isn't allowed at this point in the game");
}

/** The checks complete and undo share, in order: status, deadline, team, task. */
function checkTaskAction(snap: Snapshot, teamId: number, gameTaskId: number, now: number): Decision | null {
  const { game } = snap;
  if (game.status !== "active") return statusError(game.status);
  if (game.endsAt !== null && now >= game.endsAt) return statusError("finished");
  if (!snap.teams.some((t) => t.id === teamId)) return error(422, "validation", "That team isn't in this game");
  if (!snap.tasks.some((t) => t.id === gameTaskId)) return error(404, "not_found", "Not found");
  return null;
}

const completedAt = (snap: Snapshot, teamId: number, gameTaskId: number) =>
  snap.teamTasks.find((tt) => tt.teamId === teamId && tt.gameTaskId === gameTaskId)?.completedAt ?? null;

// SPEC.md §5: completing a done task changes nothing; the final task stays locked
// until the team's other tasks are done; completing it ends the game.
export function decideComplete(snap: Snapshot, teamId: number, gameTaskId: number, now: number): Decision {
  const failed = checkTaskAction(snap, teamId, gameTaskId, now);
  if (failed) return failed;
  if (completedAt(snap, teamId, gameTaskId) !== null) return { kind: "noop" };
  const task = snap.tasks.find((t) => t.id === gameTaskId)!;
  if (task.isFinal && !isFinalUnlocked(snap.tasks, snap.teamTasks, teamId)) {
    return error(409, "final_locked", "Finish every other task first");
  }
  const finish = task.isFinal ? { winnerTeamId: teamId } : null;
  return { kind: "change", change: { kind: "complete", teamId, gameTaskId, at: now, finish } };
}

// SPEC.md §5: the final task can't be undone; undoing an incomplete task changes nothing.
export function decideUndo(snap: Snapshot, teamId: number, gameTaskId: number, now: number): Decision {
  const failed = checkTaskAction(snap, teamId, gameTaskId, now);
  if (failed) return failed;
  const task = snap.tasks.find((t) => t.id === gameTaskId)!;
  if (task.isFinal) return error(409, "final_not_undoable", "The final task can't be undone");
  if (completedAt(snap, teamId, gameTaskId) === null) return { kind: "noop" };
  return { kind: "change", change: { kind: "undo", teamId, gameTaskId, at: now } };
}
