// Text for the history screens (SPEC.md §9).

/** "12:34" (minutes:seconds, floored), "—" when there's no time. */
export function formatElapsed(ms: number | null): string {
  if (ms === null) return "—";
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatDate(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone }).format(ms);
}

type ResultInput = { status: string; winnerTeamId: number | null; teams: { id: number; name: string }[] };

export function resultText({ status, winnerTeamId, teams }: ResultInput): string {
  if (status === "abandoned") return "Abandoned";
  const winner = teams.find((t) => t.id === winnerTeamId);
  return winner ? `${winner.name} won` : "Tie";
}

export function endReasonText(game: { status: string; endReason: string | null; startedAt: number | null }): string {
  if (game.status === "abandoned") return game.startedAt === null ? "Abandoned before start" : "Abandoned";
  return game.endReason === "completed" ? "Puzzle solved" : "Time ran out";
}
