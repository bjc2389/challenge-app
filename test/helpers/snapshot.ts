// Pure in-memory Snapshot builder for the M3 rule unit tests (SPEC.md §4, §5).
// No D1: the decide functions under test take a Snapshot and a time.
import type { GameStatus, GameTaskRow, Snapshot, TeamTaskRow } from "../../src/worker/game/types";
import { T0 } from "./db";

export const GAME_ID = 1;
export const TEAM_1 = 11;
export const TEAM_2 = 12;
/** A team id that belongs to some other game. */
export const OTHER_TEAM = 99;
export const NON_FINAL_IDS = [101, 102, 103] as const;
export const FINAL_ID = 104;
/** A game task id that belongs to some other game. */
export const OTHER_TASK = 999;

export const STARTED_AT = T0 + 2 * 60_000;
export const ENDS_AT = STARTED_AT + 3_600_000;

export const SNAPSHOT_TASKS: GameTaskRow[] = [
  { id: 101, catalogTaskId: "drinks-a", categoryId: "drinks", categoryName: "Drinks", text: "Drink A", sortOrder: 1, isFinal: false },
  { id: 102, catalogTaskId: "drinks-b", categoryId: "drinks", categoryName: "Drinks", text: "Drink B", sortOrder: 2, isFinal: false },
  { id: 103, catalogTaskId: "food-a", categoryId: "food", categoryName: "Food", text: "Food A", sortOrder: 3, isFinal: false },
  { id: 104, catalogTaskId: "puzzle-a", categoryId: "puzzle", categoryName: "Final Puzzle", text: "Puzzle A", sortOrder: 4, isFinal: true },
];

export type SnapshotOpts = {
  status?: GameStatus;
  endsAt?: number | null;
  /** [teamId, gameTaskId, completedAt] for every completed team task. */
  completed?: Array<[number, number, number]>;
};

/** A rolled-or-later game with two teams and four tasks (three non-final, then the final). */
export function makeSnapshot(opts: SnapshotOpts = {}): Snapshot {
  const status = opts.status ?? "active";
  const started = status === "active" || status === "finished";
  const done = new Map((opts.completed ?? []).map(([team, task, at]) => [`${team}:${task}`, at]));
  const teamTasks: TeamTaskRow[] = [];
  for (const teamId of [TEAM_1, TEAM_2]) {
    for (const t of SNAPSHOT_TASKS) {
      teamTasks.push({ teamId, gameTaskId: t.id, completedAt: done.get(`${teamId}:${t.id}`) ?? null });
    }
  }
  return {
    game: {
      id: GAME_ID,
      code: "ABCDE",
      status,
      version: 7,
      createdAt: T0,
      rolledAt: T0 + 60_000,
      startedAt: started ? STARTED_AT : null,
      endsAt: opts.endsAt !== undefined ? opts.endsAt : started ? ENDS_AT : null,
      endedAt: status === "finished" || status === "abandoned" ? STARTED_AT + 60_000 : null,
      endReason: status === "finished" ? "completed" : null,
      winnerTeamId: status === "finished" ? TEAM_1 : null,
    },
    teams: [
      { id: TEAM_1, slot: 1, name: "Team 1" },
      { id: TEAM_2, slot: 2, name: "Team 2" },
    ],
    tasks: SNAPSHOT_TASKS.map((t) => ({ ...t })),
    teamTasks,
  };
}

/** Every non-final task completed by `teamId`, at STARTED_AT + 1..3 minutes. */
export function allNonFinal(teamId: number): Array<[number, number, number]> {
  return NON_FINAL_IDS.map((id, i) => [teamId, id, STARTED_AT + (i + 1) * 60_000] as [number, number, number]);
}
