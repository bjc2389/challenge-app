// Admin responses (SPEC.md §10). Kept equal to the Worker's by
// test/client-admin-contract.test.ts. Times are UTC epoch ms.
import type { GameStatus } from "../game/types";

export type AdminGame = {
  code: string;
  status: GameStatus;
  isTest: boolean;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  endReason: "completed" | "timeout" | null;
  winnerTeamId: number | null;
  elapsedMs: number | null;
  teams: { id: number; slot: 1 | 2; name: string; score: number }[];
};

export type AdminGameList = { items: AdminGame[] };

export type AdminTask = { id: string; text: string; active: boolean };

export type AdminCategory = {
  id: string;
  name: string;
  order: number;
  countPerGame: number;
  final: boolean;
  active: boolean;
  tasks: AdminTask[];
};

export type AdminCatalog = { categories: AdminCategory[] };
