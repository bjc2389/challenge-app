// Text for the admin page (SPEC.md §9). Pure: no DOM.
import { ApiError } from "../apiError";
import { errorMessage } from "../game/errors";
import { formatDate, resultText } from "../history/format";
import type { AdminCategory, AdminGame } from "./types";

const inProgress = (g: AdminGame) =>
  g.status === "setup" || g.status === "rolled" || g.status === "active";

const result = (g: AdminGame) =>
  inProgress(g) ? "In progress" : resultText(g);

export function gameRow(g: AdminGame, timeZone?: string) {
  const [one, two] = [...g.teams].sort((a, b) => a.slot - b.slot);
  return {
    code: g.code,
    date: formatDate(g.createdAt, timeZone),
    statusLabel: g.status.charAt(0).toUpperCase() + g.status.slice(1),
    teams: `${one?.name} ${one?.score} – ${two?.score} ${two?.name}`,
    result: result(g),
    isTest: g.isTest,
  };
}

export function deleteConfirm(g: AdminGame): { title: string; body: string } {
  const warning = inProgress(g)
    ? "This game is in progress. Anyone playing it will see “No game with that code”. "
    : "";
  return {
    title: `Delete game ${g.code}?`,
    body: `${warning}Its history and records go too. This can't be undone.`,
  };
}

export const testToggleLabel = (g: AdminGame) =>
  g.isTest ? "Unmark test" : "Mark as test";

export const replaceGame = (
  list: readonly AdminGame[],
  updated: AdminGame,
): AdminGame[] => list.map((g) => (g.code === updated.code ? updated : g));

export const removeGame = (
  list: readonly AdminGame[],
  code: string,
): AdminGame[] => list.filter((g) => g.code !== code);

export function catalogSummary(cat: AdminCategory): string {
  return [
    `${cat.countPerGame} per game`,
    ...(cat.final ? ["final"] : []),
    ...(cat.active ? [] : ["inactive"]),
  ].join(" · ");
}

export function adminErrorMessage(err: unknown): string {
  if (err instanceof ApiError && (err.status === 401 || err.status === 403))
    return "Log in as admin";
  if (err instanceof ApiError && err.status === 404)
    return "That game no longer exists";
  return errorMessage(err);
}
