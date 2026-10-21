// Shapes shared by the pure game rules and the database layer. Times are UTC epoch ms.

/** Returns an integer in [0, maxExclusive). Injected so rolls and codes are testable. */
export type RandomInt = (maxExclusive: number) => number;

export type GameStatus = "setup" | "rolled" | "active" | "finished" | "abandoned";

export type GameRow = {
  id: number;
  code: string;
  status: GameStatus;
  version: number;
  createdAt: number;
  rolledAt: number | null;
  startedAt: number | null;
  endsAt: number | null;
  endedAt: number | null;
  endReason: "completed" | "timeout" | null;
  winnerTeamId: number | null;
};

export type TeamRow = { id: number; slot: 1 | 2; name: string };

export type GameTaskRow = {
  id: number;
  catalogTaskId: string;
  categoryId: string;
  categoryName: string;
  text: string;
  sortOrder: number;
  isFinal: boolean;
};

export type TeamTaskRow = { teamId: number; gameTaskId: number; completedAt: number | null };

/** One game as read from D1. Teams are sorted by slot, tasks by sortOrder. */
export type Snapshot = { game: GameRow; teams: TeamRow[]; tasks: GameTaskRow[]; teamTasks: TeamTaskRow[] };

export type CatalogCategory = {
  id: string;
  name: string;
  sortOrder: number;
  countPerGame: number;
  isFinal: boolean;
  active: boolean;
};

export type CatalogTask = { id: string; categoryId: string; text: string; active: boolean };

export type RolledTask = { catalogTaskId: string; categoryId: string; text: string; sortOrder: number; isFinal: boolean };

/** A state change decided by the rules, committed by db/games.ts as one batch. */
export type Change =
  | { kind: "roll"; at: number; tasks: RolledTask[] }
  | { kind: "rename"; names: [string, string] }
  | { kind: "start"; at: number; endsAt: number }
  | { kind: "complete"; teamId: number; gameTaskId: number; at: number; finish: null | { winnerTeamId: number } }
  | { kind: "undo"; teamId: number; gameTaskId: number; at: number }
  | { kind: "timeout"; endedAt: number; winnerTeamId: number | null }
  | { kind: "abandon"; at: number };

export type Decision =
  | { kind: "error"; status: 404 | 409 | 422; error: string; message: string }
  | { kind: "noop" }
  | { kind: "change"; change: Change };
