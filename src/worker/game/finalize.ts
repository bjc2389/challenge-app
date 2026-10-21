import type { GameStatus } from "./types";

// SPEC.md §4: a game is over from ends_at onward, inclusive.
export function isExpired(game: { status: GameStatus; endsAt: number | null }, now: number): boolean {
  return game.status === "active" && game.endsAt !== null && now >= game.endsAt;
}

/**
 * SPEC.md §4 timeout result: most completed tasks wins; if tied, the earlier last
 * completion wins; if still tied, there is no winner (null).
 */
export function timeoutWinner(teams: { teamId: number; completedAts: number[] }[]): number | null {
  const [a, b] = teams;
  if (!a || !b) return null;
  if (a.completedAts.length !== b.completedAts.length) {
    return a.completedAts.length > b.completedAts.length ? a.teamId : b.teamId;
  }
  if (a.completedAts.length === 0) return null;
  const lastA = Math.max(...a.completedAts);
  const lastB = Math.max(...b.completedAts);
  if (lastA === lastB) return null;
  return lastA < lastB ? a.teamId : b.teamId;
}
