// History records (SPEC.md §9). Pure: computed from finished games as read from D1.

export type HistoryTeam = {
  id: number;
  slot: 1 | 2;
  name: string;
  score: number;
  /** The team's latest non-final completion: when its puzzle last unlocked. */
  lastNonFinalAt: number | null;
  finalAt: number | null;
};

export type HistoryGame = {
  code: string;
  status: "finished" | "abandoned";
  isTest: boolean;
  startedAt: number | null;
  endedAt: number | null;
  endReason: "completed" | "timeout" | null;
  winnerTeamId: number | null;
  teams: HistoryTeam[];
};

export type RecordHolder = { code: string; teamName: string; ms: number; endedAt: number };

export type Records = { fastestWin: RecordHolder | null; fastestPuzzle: RecordHolder | null; gamesPlayed: number };

export function elapsedMs(game: { startedAt: number | null; endedAt: number | null }): number | null {
  return game.startedAt === null || game.endedAt === null ? null : game.endedAt - game.startedAt;
}

/** From the moment the puzzle unlocked (last other task, or the start) to solving it. */
export function puzzleMs(team: HistoryTeam, startedAt: number | null): number | null {
  const from = team.lastNonFinalAt ?? startedAt;
  return team.finalAt === null || from === null ? null : team.finalAt - from;
}

export function splitMs(startedAt: number | null, completedAt: number | null): number | null {
  return startedAt === null || completedAt === null ? null : completedAt - startedAt;
}

/** Records count finished games only: abandoned and test games never count. */
export const recordEligible = (game: HistoryGame) => game.status === "finished" && !game.isTest;

/** Lowest time wins; on a tie, whoever set it first, then the lower code. */
function best(candidates: RecordHolder[]): RecordHolder | null {
  let winner: RecordHolder | null = null;
  for (const c of candidates) {
    if (
      winner === null ||
      c.ms < winner.ms ||
      (c.ms === winner.ms && (c.endedAt < winner.endedAt || (c.endedAt === winner.endedAt && c.code < winner.code)))
    ) {
      winner = c;
    }
  }
  return winner;
}

/** Shortest game won by solving the puzzle. Timeout wins always last the full hour, so they don't count. */
export function fastestWin(games: HistoryGame[]): RecordHolder | null {
  const candidates: RecordHolder[] = [];
  for (const game of games) {
    if (!recordEligible(game) || game.endReason !== "completed") continue;
    const ms = elapsedMs(game);
    const winner = game.teams.find((t) => t.id === game.winnerTeamId);
    if (ms === null || !winner || game.endedAt === null) continue;
    candidates.push({ code: game.code, teamName: winner.name, ms, endedAt: game.endedAt });
  }
  return best(candidates);
}

export function fastestPuzzle(games: HistoryGame[]): RecordHolder | null {
  const candidates: RecordHolder[] = [];
  for (const game of games) {
    if (!recordEligible(game) || game.endedAt === null) continue;
    for (const team of game.teams) {
      const ms = puzzleMs(team, game.startedAt);
      if (ms !== null) candidates.push({ code: game.code, teamName: team.name, ms, endedAt: game.endedAt });
    }
  }
  return best(candidates);
}

export const gamesPlayed = (games: HistoryGame[]) => games.filter(recordEligible).length;

export function computeRecords(games: HistoryGame[]): Records {
  return { fastestWin: fastestWin(games), fastestPuzzle: fastestPuzzle(games), gamesPlayed: gamesPlayed(games) };
}
