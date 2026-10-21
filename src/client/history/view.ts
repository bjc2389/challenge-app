// Rows for the history screens, derived from API responses (SPEC.md §9).
import { formatElapsed } from "./format";
import type { HistoryDetail, HistoryItem, Records, RecordHolder } from "./types";

const bySlot = <T extends { slot: number }>(teams: T[]) => [...teams].sort((a, b) => a.slot - b.slot);

/** "Reds 4 – 3 Blues". */
export function scoreLine(item: HistoryItem): string {
  const [one, two] = bySlot(item.teams);
  return `${one?.name} ${one?.score} – ${two?.score} ${two?.name}`;
}

const holderRow = (label: string, holder: RecordHolder | null) =>
  holder
    ? { label, value: formatElapsed(holder.ms), holder: `${holder.teamName} · game ${holder.code}` }
    : { label, value: "—", holder: "No games yet" };

export function recordRows(records: Records): { label: string; value: string; holder: string }[] {
  return [
    holderRow("Fastest win", records.fastestWin),
    holderRow("Fastest puzzle", records.fastestPuzzle),
    { label: "Games played", value: String(records.gamesPlayed), holder: "Finished games" },
  ];
}

/** "+12:34 Reds completed Four Loko", in the order the server sent them. */
export function eventRows(detail: HistoryDetail): { time: string; text: string }[] {
  const teamName = new Map(detail.teams.map((t) => [t.id, t.name]));
  const taskText = new Map(detail.tasks.map((t) => [t.id, t.text]));
  return detail.events.map((e) => ({
    time: `+${formatElapsed(e.sinceStartMs)}`,
    text: `${teamName.get(e.teamId) ?? "?"} ${e.action === "complete" ? "completed" : "undid"} ${taskText.get(e.taskId) ?? "?"}`,
  }));
}

/** Each team's time from the start for each task, in slot order. */
export function splitRows(detail: HistoryDetail): { task: string; times: [string, string] }[] {
  return detail.tasks.map((task) => ({
    task: task.text,
    times: [formatElapsed(task.splitMs[0] ?? null), formatElapsed(task.splitMs[1] ?? null)],
  }));
}
