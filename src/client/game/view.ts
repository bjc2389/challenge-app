// What the game screen shows, derived from the latest GameView (SPEC.md §5, §9).
import type { GameStatus, GameView, TaskView, TeamView } from "./types";

/** Keeps the newest view; a poll that started before a write can't roll it back. */
export function pickNewer(current: GameView | null, incoming: GameView): GameView {
  return current === null || incoming.version >= current.version ? incoming : current;
}

export function teamBySlot(view: GameView, slot: 1 | 2): TeamView {
  const team = view.teams.find((t) => t.slot === slot);
  if (!team) throw new Error(`No team in slot ${slot}`);
  return team;
}

export const scoreText = (view: GameView, team: TeamView) => `${team.score}/${view.tasks.length}`;

/** For the screen-reader live region, e.g. "Reds 3, Blues 2". */
export function scoreAnnouncement(view: GameView): string {
  return [teamBySlot(view, 1), teamBySlot(view, 2)].map((t) => `${t.name} ${t.score}`).join(", ");
}

export type CellState = {
  checked: boolean;
  locked: boolean;
  /** What a tap does, or null when the cell can't be tapped. */
  action: "complete" | "undo" | null;
  busy: boolean;
  label: string;
};

export function cellState(
  view: GameView,
  task: TaskView,
  slotIndex: 0 | 1,
  opts: { timeUp: boolean; pending: boolean },
): CellState {
  const team = teamBySlot(view, slotIndex === 0 ? 1 : 2);
  const checked = task.completedAt[slotIndex] !== null;
  const locked = task.isFinal && !checked && !team.finalUnlocked;
  // The final task can't be undone: completing it ends the game.
  const readOnly =
    view.game.status !== "active" || opts.timeUp || opts.pending || locked || (task.isFinal && checked);
  const action = readOnly ? null : checked ? "undo" : "complete";
  const state = locked ? "locked until all other tasks are done" : checked ? "done" : "not done";
  return { checked, locked, action, busy: opts.pending, label: `${team.name}: ${task.text}, ${state}` };
}

export function resultBanner(view: GameView): { title: string; detail: string } | null {
  const { status, winnerTeamId, endReason } = view.game;
  if (status === "abandoned") return { title: "Game abandoned", detail: "No result recorded" };
  if (status !== "finished") return null;
  const winner = view.teams.find((t) => t.id === winnerTeamId);
  if (!winner) return { title: "It's a tie!", detail: "Time ran out with the teams level" };
  if (endReason === "completed") return { title: `${winner.name} wins!`, detail: "Solved the final puzzle first" };
  const tiedOnTasks = view.teams.every((t) => t.score === winner.score);
  return {
    title: `${winner.name} wins!`,
    detail: tiedOnTasks ? "Time ran out: tied on tasks, finished their last one first" : "Time ran out: most tasks done",
  };
}

/** Animate the task list only when this phone sees the roll happen. */
export const shouldReveal = (prev: GameStatus | null, next: GameStatus) => prev === "setup" && next === "rolled";
