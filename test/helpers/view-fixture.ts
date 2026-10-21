// Builds client GameViews (SPEC.md §10) for the pure client-module tests (M4).
// Two teams ("Reds" slot 1, "Blues" slot 2), three non-final tasks and one final task.
// Scores, finalUnlocked and lastCompletedAt are derived from `done` unless overridden,
// so a default view is always internally consistent.
import type { GameStatus, GameView, TaskView, TeamView } from "../../src/client/game/types";

/** 2026-10-20T12:00:00Z in UTC epoch ms. */
export const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
export const DURATION_MS = 3_600_000;

export const TEAM_IDS = [11, 12] as const;
export const TEAM_NAMES = ["Reds", "Blues"] as const;
/** Non-final task ids in sortOrder, then the final task id. */
export const NON_FINAL_IDS = [101, 102, 103] as const;
export const FINAL_ID = 104;

const BASE_TASKS: Omit<TaskView, "completedAt">[] = [
  { id: 101, sortOrder: 1, categoryId: "drinks", categoryName: "Drinks", text: "Drink A", isFinal: false },
  { id: 102, sortOrder: 2, categoryId: "drinks", categoryName: "Drinks", text: "Drink B", isFinal: false },
  { id: 103, sortOrder: 3, categoryId: "food", categoryName: "Food", text: "Food A", isFinal: false },
  { id: 104, sortOrder: 4, categoryId: "puzzle", categoryName: "Final Puzzle", text: "Puzzle A", isFinal: true },
];

export type ViewOverrides = {
  serverNow?: number;
  version?: number;
  status?: GameStatus;
  game?: Partial<GameView["game"]>;
  /**
   * Task ids completed per team: [slot 1, slot 2]. Each completion time is
   * startedAt + 60 s * (position in the list + 1). Default: nothing done.
   */
  done?: [number[], number[]];
  /** Per-slot overrides applied after the derived values. */
  teams?: [Partial<TeamView>?, Partial<TeamView>?];
  /** Replaces the task list entirely (completedAt included). */
  tasks?: TaskView[];
};

/** Status-appropriate timestamps for the default game. */
function gameFor(status: GameStatus): GameView["game"] {
  const createdAt = T0 - 10 * 60_000;
  const rolledAt = T0 - 5 * 60_000;
  const startedAt = T0;
  const endsAt = T0 + DURATION_MS;
  const base = {
    code: "ABCDE",
    status,
    createdAt,
    rolledAt: null,
    startedAt: null,
    endsAt: null,
    endedAt: null,
    endReason: null,
    winnerTeamId: null,
    durationMs: DURATION_MS,
  } satisfies GameView["game"];
  switch (status) {
    case "setup":
      return base;
    case "rolled":
      return { ...base, rolledAt };
    case "active":
      return { ...base, rolledAt, startedAt, endsAt };
    case "finished":
      return { ...base, rolledAt, startedAt, endsAt, endedAt: T0 + 30 * 60_000, endReason: "completed", winnerTeamId: TEAM_IDS[0] };
    case "abandoned":
      return { ...base, rolledAt, startedAt, endsAt, endedAt: T0 + 20 * 60_000 };
  }
}

export function makeView(o: ViewOverrides = {}): GameView {
  const status = o.status ?? o.game?.status ?? "active";
  const game: GameView["game"] = { ...gameFor(status), ...o.game, status };
  const startedAt = game.startedAt ?? T0;
  const done = o.done ?? [[], []];

  const tasks: TaskView[] =
    o.tasks ??
    (status === "setup"
      ? []
      : BASE_TASKS.map((t) => ({
          ...t,
          completedAt: done.map((ids) => {
            const i = ids.indexOf(t.id);
            return i === -1 ? null : startedAt + 60_000 * (i + 1);
          }),
        })));

  const teams: TeamView[] = [0, 1].map((slotIndex) => {
    const times = tasks.flatMap((t) => {
      const at = t.completedAt[slotIndex];
      return at === null || at === undefined ? [] : [at];
    });
    const nonFinal = tasks.filter((t) => !t.isFinal);
    const derived: TeamView = {
      id: TEAM_IDS[slotIndex as 0 | 1],
      slot: (slotIndex + 1) as 1 | 2,
      name: TEAM_NAMES[slotIndex as 0 | 1],
      score: times.length,
      finalUnlocked: tasks.length > 0 && nonFinal.every((t) => t.completedAt[slotIndex] !== null),
      lastCompletedAt: times.length > 0 ? Math.max(...times) : null,
    };
    return { ...derived, ...o.teams?.[slotIndex] };
  });

  return {
    serverNow: o.serverNow ?? T0 + 60_000,
    version: o.version ?? 10,
    game,
    teams,
    tasks,
  };
}

export function taskById(view: GameView, id: number): TaskView {
  const t = view.tasks.find((x: TaskView) => x.id === id);
  if (!t) throw new Error(`task ${id} not in view`);
  return t;
}
