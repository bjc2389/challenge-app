import { GAME_DURATION_MS } from "./constants";
import { isExpired } from "./finalize";
import { isFinalUnlocked } from "./lock";
import { validateTeamNames } from "./names";
import { rollTasks } from "./roll";
import type { CatalogCategory, CatalogTask, Decision, GameStatus, RandomInt, Snapshot } from "./types";

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

/**
 * The 409 if `action` isn't allowed now, or null. An active game past its deadline
 * is over even before the timeout has been written (SPEC.md §4).
 */
function gate(snap: Snapshot, action: Action, now: number): Decision | null {
  if (!canDo(snap.game.status, action)) return statusError(snap.game.status);
  if (isExpired(snap.game, now)) return statusError("finished");
  return null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** SPEC.md §4: rename both teams in setup or rolled. Same names again is a noop. */
export function decideRename(snap: Snapshot, body: unknown): Decision {
  // Only setup and rolled allow renaming, and neither has a deadline.
  if (!canDo(snap.game.status, "renameTeams")) return statusError(snap.game.status);
  if (!isObject(body)) return error(422, "validation", "Send JSON with team1 and team2");
  const result = validateTeamNames(body.team1, body.team2);
  if (!result.ok) return error(422, "validation", result.message);
  const [one, two] = result.names;
  if (snap.teams[0]?.name === one && snap.teams[1]?.name === two) return { kind: "noop" };
  return { kind: "change", change: { kind: "rename", names: result.names } };
}

/** SPEC.md §5: roll from setup only, from the active catalog read at roll time. */
export function decideRoll(
  snap: Snapshot,
  catalog: { categories: CatalogCategory[]; tasks: CatalogTask[] },
  rand: RandomInt,
  now: number,
): Decision {
  const blocked = gate(snap, "roll", now);
  if (blocked) return blocked;
  const result = rollTasks(catalog.categories, catalog.tasks, rand);
  if (!result.ok) return error(409, "catalog_incomplete", result.message);
  return { kind: "change", change: { kind: "roll", at: now, tasks: result.tasks } };
}

/** SPEC.md §4: start from rolled; the game ends 60 minutes later. */
export function decideStart(snap: Snapshot, now: number): Decision {
  return gate(snap, "start", now) ?? { kind: "change", change: { kind: "start", at: now, endsAt: now + GAME_DURATION_MS } };
}

/** SPEC.md §4: abandon from setup, rolled or active, but not once time is up. */
export function decideAbandon(snap: Snapshot, now: number): Decision {
  return gate(snap, "abandon", now) ?? { kind: "change", change: { kind: "abandon", at: now } };
}

/** The checks complete and undo share, in order: status, deadline, team, task. */
function checkTaskAction(snap: Snapshot, teamId: unknown, gameTaskId: number, now: number): Decision | null {
  const { game } = snap;
  if (game.status !== "active") return statusError(game.status);
  if (game.endsAt !== null && now >= game.endsAt) return statusError("finished");
  if (typeof teamId !== "number" || !Number.isSafeInteger(teamId)) {
    return error(422, "validation", "Send JSON with a numeric teamId");
  }
  if (!snap.teams.some((t) => t.id === teamId)) return error(422, "validation", "That team isn't in this game");
  if (!snap.tasks.some((t) => t.id === gameTaskId)) return error(404, "not_found", "Not found");
  return null;
}

const completedAt = (snap: Snapshot, teamId: number, gameTaskId: number) =>
  snap.teamTasks.find((tt) => tt.teamId === teamId && tt.gameTaskId === gameTaskId)?.completedAt ?? null;

// SPEC.md §5: completing a done task changes nothing; the final task stays locked
// until the team's other tasks are done; completing it ends the game.
export function decideComplete(snap: Snapshot, rawTeamId: unknown, gameTaskId: number, now: number): Decision {
  const failed = checkTaskAction(snap, rawTeamId, gameTaskId, now);
  if (failed) return failed;
  const teamId = rawTeamId as number; // checkTaskAction validated it
  if (completedAt(snap, teamId, gameTaskId) !== null) return { kind: "noop" };
  const task = snap.tasks.find((t) => t.id === gameTaskId)!;
  if (task.isFinal && !isFinalUnlocked(snap.tasks, snap.teamTasks, teamId)) {
    return error(409, "final_locked", "Finish every other task first");
  }
  const finish = task.isFinal ? { winnerTeamId: teamId } : null;
  return { kind: "change", change: { kind: "complete", teamId, gameTaskId, at: now, finish } };
}

// SPEC.md §5: the final task can't be undone; undoing an incomplete task changes nothing.
export function decideUndo(snap: Snapshot, rawTeamId: unknown, gameTaskId: number, now: number): Decision {
  const failed = checkTaskAction(snap, rawTeamId, gameTaskId, now);
  if (failed) return failed;
  const teamId = rawTeamId as number; // checkTaskAction validated it
  const task = snap.tasks.find((t) => t.id === gameTaskId)!;
  if (task.isFinal) return error(409, "final_not_undoable", "The final task can't be undone");
  if (completedAt(snap, teamId, gameTaskId) === null) return { kind: "noop" };
  return { kind: "change", change: { kind: "undo", teamId, gameTaskId, at: now } };
}
