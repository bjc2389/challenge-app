// SPEC.md §9 /admin and §10 admin endpoints: the client's admin types must match what
// the Worker returns. The type-level checks run under `npm run check`
// (tsc -p tsconfig.worker.json); the runtime checks hit D1.
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type { AdminCatalog, AdminCategory, AdminGame, AdminGameList, AdminTask } from "../src/client/admin/types";
import type { GameStatus } from "../src/client/game/types";
import { toAdminCatalog, toAdminGame, toAdminGameList } from "../src/worker/api/adminView";
import { makeDeps } from "./helpers/auth";
import { T0, resetDb } from "./helpers/db";
import { admin, adminGameUrl, getAdminCatalog, listAdminGames, setTest } from "./helpers/admin";
import { player, seedRollCatalog } from "./helpers/game";
import { HOUR, namedGame, redsBluesGame } from "./helpers/history";

type WorkerList = ReturnType<typeof toAdminGameList>;
type WorkerGame = ReturnType<typeof toAdminGame>;
type WorkerCatalog = ReturnType<typeof toAdminCatalog>;

// Exhaustive at compile time: a missing or extra key fails the typecheck.
const LIST_KEYS: Record<keyof AdminGameList, true> = { items: true };
const GAME_KEYS: Record<keyof AdminGame, true> = {
  code: true,
  status: true,
  isTest: true,
  createdAt: true,
  startedAt: true,
  endedAt: true,
  endReason: true,
  winnerTeamId: true,
  elapsedMs: true,
  teams: true,
};
const TEAM_KEYS: Record<keyof AdminGame["teams"][number], true> = { id: true, slot: true, name: true, score: true };
const CATALOG_KEYS: Record<keyof AdminCatalog, true> = { categories: true };
const CATEGORY_KEYS: Record<keyof AdminCategory, true> = {
  id: true,
  name: true,
  order: true,
  countPerGame: true,
  final: true,
  active: true,
  tasks: true,
};
const TASK_KEYS: Record<keyof AdminTask, true> = { id: true, text: true, active: true };
const sorted = (o: object) => Object.keys(o).sort();

describe("§10 AdminGameList and AdminGame: client types equal the worker's", () => {
  it("type level, nested types too", () => {
    expectTypeOf<WorkerList>().toEqualTypeOf<AdminGameList>();
    expectTypeOf<WorkerGame>().toEqualTypeOf<AdminGame>();
    expectTypeOf<WorkerList["items"][number]>().toEqualTypeOf<AdminGame>();
    expectTypeOf<WorkerGame["teams"][number]>().toEqualTypeOf<AdminGame["teams"][number]>();
    expectTypeOf<AdminGameList["items"]>().toEqualTypeOf<AdminGame[]>();
    expectTypeOf<AdminGame["status"]>().toEqualTypeOf<GameStatus>();
    expectTypeOf<AdminGame["isTest"]>().toEqualTypeOf<boolean>();
    expectTypeOf<AdminGame["createdAt"]>().toEqualTypeOf<number>();
    expectTypeOf<AdminGame["startedAt"]>().toEqualTypeOf<number | null>();
    expectTypeOf<AdminGame["endedAt"]>().toEqualTypeOf<number | null>();
    expectTypeOf<AdminGame["endReason"]>().toEqualTypeOf<"completed" | "timeout" | null>();
    expectTypeOf<AdminGame["winnerTeamId"]>().toEqualTypeOf<number | null>();
    expectTypeOf<AdminGame["elapsedMs"]>().toEqualTypeOf<number | null>();
    expectTypeOf<AdminGame["teams"][number]>().toEqualTypeOf<{ id: number; slot: 1 | 2; name: string; score: number }>();
  });

  it("the documented key lists are the plan's", () => {
    expect(sorted(LIST_KEYS)).toEqual(["items"]);
    expect(sorted(GAME_KEYS)).toEqual([
      "code",
      "createdAt",
      "elapsedMs",
      "endReason",
      "endedAt",
      "isTest",
      "startedAt",
      "status",
      "teams",
      "winnerTeamId",
    ]);
    expect(sorted(TEAM_KEYS)).toEqual(["id", "name", "score", "slot"]);
  });
});

describe("§7 §10 AdminCatalog: client types equal the worker's", () => {
  it("type level, nested types too", () => {
    expectTypeOf<WorkerCatalog>().toEqualTypeOf<AdminCatalog>();
    expectTypeOf<WorkerCatalog["categories"][number]>().toEqualTypeOf<AdminCategory>();
    expectTypeOf<WorkerCatalog["categories"][number]["tasks"][number]>().toEqualTypeOf<AdminTask>();
    expectTypeOf<AdminCatalog["categories"]>().toEqualTypeOf<AdminCategory[]>();
    expectTypeOf<AdminCategory["tasks"]>().toEqualTypeOf<AdminTask[]>();
    expectTypeOf<AdminCategory["final"]>().toEqualTypeOf<boolean>();
    expectTypeOf<AdminCategory["active"]>().toEqualTypeOf<boolean>();
    expectTypeOf<AdminCategory["order"]>().toEqualTypeOf<number>();
    expectTypeOf<AdminCategory["countPerGame"]>().toEqualTypeOf<number>();
    expectTypeOf<AdminTask>().toEqualTypeOf<{ id: string; text: string; active: boolean }>();
  });

  it("the documented key lists are the plan's", () => {
    expect(sorted(CATALOG_KEYS)).toEqual(["categories"]);
    expect(sorted(CATEGORY_KEYS)).toEqual(["active", "countPerGame", "final", "id", "name", "order", "tasks"]);
    expect(sorted(TASK_KEYS)).toEqual(["active", "id", "text"]);
  });
});

describe("§10 the real admin responses have exactly the client's keys", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRollCatalog();
  });

  it("GET /api/admin/games (a finished game and a setup game)", async () => {
    const clock = makeDeps();
    const api = await player(clock.deps);
    await redsBluesGame(api, clock, T0);
    await namedGame(api, clock, { at: T0 + 2 * HOUR });
    const body = await listAdminGames(await admin(clock.deps));
    expect(sorted(body)).toEqual(sorted(LIST_KEYS));
    expect(body.items).toHaveLength(2);
    for (const item of body.items) {
      expect(sorted(item)).toEqual(sorted(GAME_KEYS));
      expect(item.teams).toHaveLength(2);
      for (const team of item.teams) expect(sorted(team)).toEqual(sorted(TEAM_KEYS));
    }
  });

  it("PATCH /api/admin/games/:code", async () => {
    const clock = makeDeps();
    const api = await player(clock.deps);
    const g = await redsBluesGame(api, clock, T0);
    const adm = await admin(clock.deps);
    const body = await setTest(adm, g.code, true);
    expect(sorted(body)).toEqual(sorted(GAME_KEYS));
    for (const team of body.teams) expect(sorted(team)).toEqual(sorted(TEAM_KEYS));
    // The same shape as the list item.
    const item = (await listAdminGames(adm)).items.find((x) => x.code === g.code);
    expect(body).toEqual(item);
    expect(adminGameUrl(g.code)).toBe(`/api/admin/games/${g.code}`);
  });

  it("GET /api/admin/catalog", async () => {
    const body = await getAdminCatalog(await admin(makeDeps().deps));
    expect(sorted(body)).toEqual(sorted(CATALOG_KEYS));
    expect(body.categories.length).toBeGreaterThan(0);
    for (const cat of body.categories) {
      expect(sorted(cat)).toEqual(sorted(CATEGORY_KEYS));
      expect(cat.tasks.length).toBeGreaterThan(0);
      for (const task of cat.tasks) expect(sorted(task)).toEqual(sorted(TASK_KEYS));
    }
  });
});
