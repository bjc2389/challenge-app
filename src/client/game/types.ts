// The game view every game endpoint returns (SPEC.md §10). Defined here rather than
// imported, so the client never imports Worker code; test/client-contract.test.ts
// keeps the two in step. Times are UTC epoch ms.
export type GameStatus = "setup" | "rolled" | "active" | "finished" | "abandoned";

export type TeamView = {
  id: number;
  slot: 1 | 2;
  name: string;
  score: number;
  finalUnlocked: boolean;
  lastCompletedAt: number | null;
};

export type TaskView = {
  id: number;
  sortOrder: number;
  categoryId: string;
  categoryName: string;
  text: string;
  isFinal: boolean;
  /** One entry per team, in slot order; null while not done. */
  completedAt: (number | null)[];
};

export type GameView = {
  serverNow: number;
  version: number;
  game: {
    code: string;
    status: GameStatus;
    createdAt: number;
    rolledAt: number | null;
    startedAt: number | null;
    endsAt: number | null;
    endedAt: number | null;
    endReason: "completed" | "timeout" | null;
    winnerTeamId: number | null;
    durationMs: number;
  };
  teams: TeamView[];
  tasks: TaskView[];
};

export const isOver = (view: GameView) => view.game.status === "finished" || view.game.status === "abandoned";
