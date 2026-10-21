// History responses (SPEC.md §10). Kept equal to the Worker's by
// test/client-history-contract.test.ts. Times are UTC epoch ms.
import type { GameStatus } from "../game/types";

export type RecordHolder = { code: string; teamName: string; ms: number; endedAt: number };

export type Records = { fastestWin: RecordHolder | null; fastestPuzzle: RecordHolder | null; gamesPlayed: number };

export type HistoryItem = {
  code: string;
  status: "finished" | "abandoned";
  startedAt: number | null;
  endedAt: number | null;
  elapsedMs: number | null;
  endReason: "completed" | "timeout" | null;
  winnerTeamId: number | null;
  teams: { id: number; slot: 1 | 2; name: string; score: number }[];
};

export type HistoryList = { items: HistoryItem[]; hasMore: boolean; records: Records };

export type HistoryTeam = { id: number; slot: 1 | 2; name: string; score: number; puzzleMs: number | null };

export type HistoryTask = {
  id: number;
  sortOrder: number;
  categoryName: string;
  text: string;
  isFinal: boolean;
  /** Per team, in slot order; null while not done. */
  splitMs: (number | null)[];
};

export type HistoryEvent = {
  id: number;
  at: number;
  sinceStartMs: number | null;
  teamId: number;
  taskId: number;
  action: "complete" | "undo";
};

export type HistoryDetail = {
  game: {
    code: string;
    status: GameStatus;
    createdAt: number;
    startedAt: number | null;
    endsAt: number | null;
    endedAt: number | null;
    endReason: "completed" | "timeout" | null;
    winnerTeamId: number | null;
    elapsedMs: number | null;
  };
  teams: HistoryTeam[];
  tasks: HistoryTask[];
  events: HistoryEvent[];
};
