// SPEC.md §8 ("Deleting a game deletes all of its child rows in one batch, in this order:
// clear games.winner_team_id; delete task_events; team_tasks; game_tasks; teams; the games
// row"), §9 /admin ("deleted (with confirmation; this is a permanent delete)"), §3
// cross-origin rule, §10 DELETE /api/admin/games/:code. Approved M6 plan:
// - 200 `{ok: true}`; allowed in every state; unknown, already deleted or malformed codes
//   are 404 `not_found`; afterwards the game GET and complete are 404;
// - deleteGame(db, code) in src/worker/db/admin.ts returns false when nothing was deleted.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteGame } from "../src/worker/db/admin";
import { commitChange, loadSnapshot } from "../src/worker/db/games";
import type { Change } from "../src/worker/game/types";
import { expectError, makeDeps } from "./helpers/auth";
import { T0, gameRowCounts, resetDb, seedFullGame } from "./helpers/db";
import { adminGameUrl, admin, listAdminGames, readAdminJson, tableCounts, type AdminApi } from "./helpers/admin";
import {
  anonymous,
  complete,
  expectApiError,
  gameIn,
  gameRow,
  gameState,
  gameUrl,
  player,
  readView,
  seedRollCatalog,
  seqRandom,
  type Api,
  type Status,
} from "./helpers/game";
import { MIN, historyUrl, markTest, startedGame, type Clock } from "./helpers/history";

let clock: Clock;
let api: Api;
let adm: AdminApi;

beforeEach(async () => {
  await resetDb();
  await seedRollCatalog();
  clock = makeDeps();
  api = await player(clock.deps);
  adm = await admin(clock.deps);
});

const ZERO = { games: 0, teams: 0, game_tasks: 0, team_tasks: 0, task_events: 0 };

/** Adds the catalog rows seedFullGame's tasks point at (cat-a, cat-final). */
async function seedMiniCatalogRows() {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO categories (id, name, sort_order, count_per_game, is_final, active) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("cat-a", "Category A", 10, 2, 0, 0),
    env.DB.prepare(
      "INSERT INTO categories (id, name, sort_order, count_per_game, is_final, active) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("cat-final", "Category Final", 11, 1, 1, 0),
    env.DB.prepare("INSERT INTO catalog_tasks (id, category_id, text) VALUES (?, ?, ?)").bind("task-a1", "cat-a", "Task task-a1"),
    env.DB.prepare("INSERT INTO catalog_tasks (id, category_id, text) VALUES (?, ?, ?)").bind("task-a2", "cat-a", "Task task-a2"),
    env.DB.prepare("INSERT INTO catalog_tasks (id, category_id, text) VALUES (?, ?, ?)").bind(
      "task-final",
      "cat-final",
      "Task task-final",
    ),
  ]);
}

async function expectDeleted(res: Response) {
  const body = await readAdminJson<unknown>(res, 200);
  expect(body).toEqual({ ok: true });
}

describe("§3 §10 DELETE /api/admin/games/:code is admin-only", () => {
  it("anonymous gets 401 and nothing is deleted", async () => {
    const g = await startedGame(api, clock, { at: T0 });
    const before = await gameRowCounts(g.gameId);
    await expectError(await anonymous(clock.deps, "DELETE", adminGameUrl(g.code)), 401, "unauthorized", "Log in to continue");
    expect(await gameRowCounts(g.gameId)).toEqual(before);
  });

  it("a player gets 403 and nothing is deleted", async () => {
    const g = await startedGame(api, clock, { at: T0 });
    const before = await gameRowCounts(g.gameId);
    const res = await api.request("DELETE", adminGameUrl(g.code));
    await expectError(res, 403, "forbidden", "Admin access required");
    expect(await gameRowCounts(g.gameId)).toEqual(before);
  });
});

describe("§8 §10 DELETE /api/admin/games/:code removes the game and every child row", () => {
  it("a fully seeded game (winner, events with an undo, team_tasks): 200 {ok:true}, every count 0", async () => {
    await seedMiniCatalogRows();
    const seeded = await seedFullGame("SEEDA");
    const counts = await gameRowCounts(seeded.gameId);
    // Sanity: every kind of child row exists, and the winner is set.
    expect(counts).toEqual({ games: 1, teams: 2, game_tasks: 3, team_tasks: 6, task_events: 3 });
    expect((await gameRow("SEEDA")).winner_team_id).toBe(seeded.teamIds[0]);
    expect((await gameState(seeded.gameId)).events.map((e) => e.action)).toContain("undo");

    await expectDeleted(await adm.delete(adminGameUrl("SEEDA")));
    expect(await gameRowCounts(seeded.gameId)).toEqual(ZERO);
    // team_tasks for the old team ids are gone too (not just unreachable through game_tasks).
    const orphans = await env.DB.prepare("SELECT COUNT(*) AS n FROM team_tasks WHERE team_id IN (?, ?)")
      .bind(seeded.teamIds[0], seeded.teamIds[1])
      .first<{ n: number }>();
    expect(orphans?.n).toBe(0);
  });

  it("other games are untouched, and the catalog is untouched", async () => {
    await seedMiniCatalogRows();
    const target = await seedFullGame("SEEDA");
    const other = await seedFullGame("SEEDB");
    const otherBefore = await gameState(other.gameId);
    const totals = await tableCounts();

    await expectDeleted(await adm.delete(adminGameUrl("SEEDA")));
    expect(await gameRowCounts(target.gameId)).toEqual(ZERO);
    expect(await gameState(other.gameId)).toEqual(otherBefore);
    expect(await tableCounts()).toEqual({
      ...totals,
      games: totals.games! - 1,
      teams: totals.teams! - 2,
      game_tasks: totals.game_tasks! - 3,
      team_tasks: totals.team_tasks! - 6,
      task_events: totals.task_events! - 3,
    });
  });

  it("the deleted game leaves the admin list; the others stay", async () => {
    const a = await startedGame(api, clock, { at: T0 });
    const b = await startedGame(api, clock, { at: T0 + MIN });
    await expectDeleted(await adm.delete(adminGameUrl(a.code)));
    expect((await listAdminGames(adm)).items.map((g) => g.code)).toEqual([b.code]);
  });

  it("accepts a lowercase code", async () => {
    const g = await startedGame(api, clock, { at: T0 });
    await expectDeleted(await adm.delete(adminGameUrl(g.code.toLowerCase())));
    expect(await gameRowCounts(g.gameId)).toEqual(ZERO);
  });

  const states: Status[] = ["setup", "rolled", "active", "finished", "abandoned"];
  it.each(states)("works on a %s game", async (status) => {
    const g = await gameIn(api, status);
    expect((await gameRow(g.code)).status).toBe(status);
    await expectDeleted(await adm.delete(adminGameUrl(g.code)));
    expect(await gameRowCounts(g.gameId)).toEqual(ZERO);
  });

  it("works on a test game", async () => {
    const g = await gameIn(api, "finished");
    await markTest(g.code);
    await expectDeleted(await adm.delete(adminGameUrl(g.code)));
    expect(await gameRowCounts(g.gameId)).toEqual(ZERO);
  });
});

describe("§10 DELETE /api/admin/games/:code not found", () => {
  it("an unknown code gets 404 not_found", async () => {
    await expectApiError(await adm.delete(adminGameUrl("ZZZZZ")), 404, "not_found");
  });

  it("a repeat delete gets 404 not_found", async () => {
    const g = await startedGame(api, clock, { at: T0 });
    await expectDeleted(await adm.delete(adminGameUrl(g.code)));
    await expectApiError(await adm.delete(adminGameUrl(g.code)), 404, "not_found");
  });

  it.each(["ABCD", "ABCDEF", "ABCD1", "ABCDO", "AB-DE"])("a malformed code %s gets 404 not_found", async (code) => {
    const g = await startedGame(api, clock, { at: T0 });
    const totals = await tableCounts();
    await expectApiError(await adm.delete(adminGameUrl(code)), 404, "not_found");
    expect(await tableCounts()).toEqual(totals);
    expect((await gameRowCounts(g.gameId)).games).toBe(1);
  });
});

describe("§8 §10 after a delete the game is gone everywhere", () => {
  it("GET /api/games/:code and complete get 404; history detail gets 404", async () => {
    const g = await startedGame(api, clock, { at: T0 });
    await expectDeleted(await adm.delete(adminGameUrl(g.code)));
    await expectApiError(await api.get(gameUrl(g.code)), 404, "not_found");
    clock.advance(MIN);
    await expectApiError(await complete(api, g.code, g.taskIds[0] as number, g.teamIds[0]), 404, "not_found");
    await expectApiError(await api.get(historyUrl(g.code)), 404, "not_found");
    expect(await gameRowCounts(g.gameId)).toEqual(ZERO);
  });

  it("a finished game disappears from /api/history and its records", async () => {
    const g = await gameIn(api, "finished");
    const listed = await readView(await api.get(gameUrl(g.code)));
    expect(listed.game.status).toBe("finished");
    await expectDeleted(await adm.delete(adminGameUrl(g.code)));
    const res = await api.get(historyUrl());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [],
      hasMore: false,
      records: { fastestWin: null, fastestPuzzle: null, gamesPlayed: 0 },
    });
  });
});

describe("§4 §8 deleteGame (db layer)", () => {
  it("returns true when it deleted the game, then false for the same code", async () => {
    const g = await startedGame(api, clock, { at: T0 });
    expect(await deleteGame(env.DB, g.code)).toBe(true);
    expect(await gameRowCounts(g.gameId)).toEqual(ZERO);
    expect(await deleteGame(env.DB, g.code)).toBe(false);
  });

  it("returns false and deletes nothing for an unknown code", async () => {
    await startedGame(api, clock, { at: T0 });
    const totals = await tableCounts();
    expect(await deleteGame(env.DB, "ZZZZZ")).toBe(false);
    expect(await tableCounts()).toEqual(totals);
  });

  it("an in-flight write loses: a complete committed with the pre-delete version writes nothing", async () => {
    const g = await startedGame(api, clock, { at: T0 });
    clock.advance(MIN);
    const snap = await loadSnapshot(env.DB, g.code);
    if (!snap) throw new Error("no snapshot");

    expect(await deleteGame(env.DB, g.code)).toBe(true);

    const change: Change = {
      kind: "complete",
      teamId: g.teamIds[0],
      gameTaskId: g.taskIds[0] as number,
      at: clock.deps.now(),
      finish: null,
    };
    expect(await commitChange(env.DB, snap.game.id, snap.game.version, change)).toBe(false);

    const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM task_events WHERE game_id = ?")
      .bind(snap.game.id)
      .first<{ n: number }>();
    expect(events?.n).toBe(0);
    const teamTasks = await env.DB.prepare("SELECT COUNT(*) AS n FROM team_tasks WHERE team_id IN (?, ?)")
      .bind(g.teamIds[0], g.teamIds[1])
      .first<{ n: number }>();
    expect(teamTasks?.n).toBe(0);
    expect(await gameRowCounts(snap.game.id)).toEqual(ZERO);
  });
});

describe("§4 §8 a deleted code can be used again", () => {
  it("the random source gives the same code again: 201, a fresh game in setup", async () => {
    const first = await player(makeDeps({ random: seqRandom([0, 1, 2, 3, 4]) }).deps);
    const created = await readView(await first.post("/api/games"), 201);
    expect(created.game.code).toBe("ABCDE");
    await readView(await first.patch(gameUrl("ABCDE", "/teams"), { team1: "Reds", team2: "Blues" }));
    await expectDeleted(await adm.delete(adminGameUrl("ABCDE")));

    const second = await player(makeDeps({ now: T0 + MIN, random: seqRandom([0, 1, 2, 3, 4]) }).deps);
    const again = await readView(await second.post("/api/games"), 201);
    expect(again.game).toMatchObject({ code: "ABCDE", status: "setup", createdAt: T0 + MIN });
    expect(again.teams.map((t) => t.name)).toEqual(["Team 1", "Team 2"]);
    expect(again.tasks).toEqual([]);
    expect(again.version).toBe(0);
    expect(await gameRowCounts((await gameRow("ABCDE")).id)).toEqual({ ...ZERO, games: 1, teams: 2 });
  });
});

describe("§3 cross-origin DELETE /api/admin/games/:code gets 403", () => {
  it.each([
    ["an Origin from another site", { origin: "https://evil.example" }],
    ["Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }],
  ])("%s: 403 and nothing is deleted", async (_name, headers) => {
    const g = await startedGame(api, clock, { at: T0 });
    const before = await gameState(g.gameId);
    await expectError(await adm.delete(adminGameUrl(g.code), headers), 403, "forbidden", "Cross-origin request blocked");
    expect(await gameState(g.gameId)).toEqual(before);
  });
});
