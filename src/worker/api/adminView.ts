// The JSON the admin endpoints return (SPEC.md §10).
import type { AdminGameRow, CatalogRows } from "../db/admin";
import { elapsedMs } from "../game/records";

export function toAdminGame(g: AdminGameRow) {
  return {
    code: g.code,
    status: g.status,
    isTest: g.isTest,
    createdAt: g.createdAt,
    startedAt: g.startedAt,
    endedAt: g.endedAt,
    endReason: g.endReason,
    winnerTeamId: g.winnerTeamId,
    elapsedMs: elapsedMs(g),
    teams: g.teams.map((t) => ({ id: t.id, slot: t.slot, name: t.name, score: t.score })),
  };
}

export function toAdminGameList(games: AdminGameRow[]) {
  return { items: games.map(toAdminGame) };
}

/** Field names match catalog/catalog.json, with tasks nested under their category. */
export function toAdminCatalog(rows: CatalogRows) {
  return {
    categories: rows.categories.map((c) => ({
      id: c.id,
      name: c.name,
      order: c.sortOrder,
      countPerGame: c.countPerGame,
      final: c.isFinal,
      active: c.active,
      tasks: rows.tasks
        .filter((t) => t.categoryId === c.id)
        .map((t) => ({ id: t.id, text: t.text, active: t.active })),
    })),
  };
}
