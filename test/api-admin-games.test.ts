// SPEC.md §9 /admin games table (code, date, status, teams, result, test flag) and
// §10 GET /api/admin/games. Approved M6 plan:
// - admin-only: anonymous 401 `unauthorized`, player 403 `forbidden` "Admin access required";
// - `{ items: AdminGame[] }`: every game (test games, and every status), newest first by
//   createdAt DESC then id DESC, no cap;
// - AdminGame = { code, status, isTest, createdAt, startedAt, endedAt, endReason,
//   winnerTeamId, elapsedMs, teams: [{id, slot, name, score}] }, teams by slot,
//   elapsedMs = endedAt − startedAt when both are set, score = completed tasks;
// - §4: it first sweeps expired games with sweepExpiredGames, limit 5.
// Time moves only through the injected clock.
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TTL_MS } from "../src/worker/auth/session";
import { NOW, expectError, makeDeps } from "./helpers/auth";
import { T0, resetDb } from "./helpers/db";
import {
  ADMIN_GAMES_URL,
  ADMIN_GAME_KEYS,
  ADMIN_TEAM_KEYS,
  admin,
  listAdminGames,
  sortedKeys,
  type AdminApi,
  type AdminGameBody,
  type AdminTeamBody,
} from "./helpers/admin";
import {
  NON_FINAL_PER_GAME,
  anonymous,
  gameRow,
  player,
  seedRollCatalog,
  teamRows,
  type Api,
} from "./helpers/game";
import {
  HOUR,
  MIN,
  abandonNow,
  bulkCode,
  expiredGame,
  finishedGame,
  insertHistoryGames,
  markTest,
  namedGame,
  play,
  rolledNamedGame,
  startedGame,
  timedOutGame,
  type Clock,
} from "./helpers/history";

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

/** The expected `teams` array for a game, read from D1, with the given scores by slot. */
async function expectedTeams(gameId: number, scores: [number, number]): Promise<AdminTeamBody[]> {
  const rows = await teamRows(gameId);
  expect(rows.map((t) => t.slot)).toEqual([1, 2]);
  return rows.map((t) => ({ id: t.id, slot: t.slot as 1 | 2, name: t.name, score: scores[t.slot - 1] as number }));
}

describe("§3 §10 GET /api/admin/games is admin-only", () => {
  it("anonymous gets 401 unauthorized", async () => {
    await expectError(await anonymous(clock.deps, "GET", ADMIN_GAMES_URL), 401, "unauthorized", "Log in to continue");
  });

  it("a player gets 403 forbidden", async () => {
    await expectError(await api.get(ADMIN_GAMES_URL), 403, "forbidden", "Admin access required");
  });

  it("an admin cookie works until the 12-hour expiry and gets 401 at it", async () => {
    // The default admin cookie expires at NOW + 12 hours.
    expect(NOW + ADMIN_TTL_MS).toBe(NOW + 12 * HOUR);
    clock.setNow(NOW + ADMIN_TTL_MS - 1);
    expect((await adm.get(ADMIN_GAMES_URL)).status).toBe(200);
    clock.setNow(NOW + ADMIN_TTL_MS);
    await expectError(await adm.get(ADMIN_GAMES_URL), 401, "unauthorized", "Log in to continue");
  });

  it("an admin cookie that expired an hour ago gets 401", async () => {
    const stale = await admin(clock.deps, { exp: NOW - HOUR });
    await expectError(await stale.get(ADMIN_GAMES_URL), 401, "unauthorized", "Log in to continue");
  });
});

describe("§9 §10 GET /api/admin/games with no games", () => {
  it("returns exactly { items: [] }", async () => {
    const body = await listAdminGames(adm);
    expect(body).toEqual({ items: [] });
    expect(sortedKeys(body)).toEqual(["items"]);
  });
});

describe("§9 §10 GET /api/admin/games lists one game per state, plus a test game", () => {
  it("every game, newest first, with exact fields, scores and elapsedMs", async () => {
    // A: finished as a completion win by slot 1 (3 non-final tasks, then the final at +20 min).
    const a = await finishedGame(api, clock, { at: T0, names: ["Reds", "Blues"], finalMin: 20 });
    // B: finished as a timeout tie (one task each at the same minute).
    const b = await timedOutGame(api, clock, {
      at: T0 + HOUR,
      names: ["Greens", "Golds"],
      steps: [
        { slot: 1, task: 0, min: 5 },
        { slot: 2, task: 0, min: 5 },
      ],
    });
    // C: abandoned from setup, 5 minutes after it was created.
    const c = await namedGame(api, clock, { at: T0 + 3 * HOUR, names: ["Pinks", "Greys"] });
    clock.advance(5 * MIN);
    await abandonNow(api, c.code);
    // D: setup.
    const d = await namedGame(api, clock, { at: T0 + 4 * HOUR, names: ["Ones", "Twos"] });
    // E: rolled.
    const e = await rolledNamedGame(api, clock, { at: T0 + 5 * HOUR, names: ["Ups", "Downs"] });
    // F: active, slot 2 has one task done.
    const f = await startedGame(api, clock, { at: T0 + 6 * HOUR, names: ["Lefts", "Rights"] });
    await play(api, clock, f, [{ slot: 2, task: 1, min: 3 }]);
    // G: a test game, still in setup.
    const g = await namedGame(api, clock, { at: T0 + 7 * HOUR, names: ["Tests", "Probes"] });
    await markTest(g.code);

    // Before F's deadline, so nothing is swept.
    clock.setNow(T0 + 7 * HOUR + MIN);
    expect(f.endsAt).toBeGreaterThan(clock.deps.now());
    const body = await listAdminGames(adm);

    const expected: AdminGameBody[] = [
      {
        code: g.code,
        status: "setup",
        isTest: true,
        createdAt: T0 + 7 * HOUR,
        startedAt: null,
        endedAt: null,
        endReason: null,
        winnerTeamId: null,
        elapsedMs: null,
        teams: await expectedTeams(g.gameId, [0, 0]),
      },
      {
        code: f.code,
        status: "active",
        isTest: false,
        createdAt: T0 + 6 * HOUR,
        startedAt: f.startedAt,
        endedAt: null,
        endReason: null,
        winnerTeamId: null,
        elapsedMs: null,
        teams: await expectedTeams(f.gameId, [0, 1]),
      },
      {
        code: e.code,
        status: "rolled",
        isTest: false,
        createdAt: T0 + 5 * HOUR,
        startedAt: null,
        endedAt: null,
        endReason: null,
        winnerTeamId: null,
        elapsedMs: null,
        teams: await expectedTeams(e.gameId, [0, 0]),
      },
      {
        code: d.code,
        status: "setup",
        isTest: false,
        createdAt: T0 + 4 * HOUR,
        startedAt: null,
        endedAt: null,
        endReason: null,
        winnerTeamId: null,
        elapsedMs: null,
        teams: await expectedTeams(d.gameId, [0, 0]),
      },
      {
        code: c.code,
        status: "abandoned",
        isTest: false,
        createdAt: T0 + 3 * HOUR,
        startedAt: null,
        endedAt: T0 + 3 * HOUR + 5 * MIN,
        endReason: null,
        winnerTeamId: null,
        elapsedMs: null,
        teams: await expectedTeams(c.gameId, [0, 0]),
      },
      {
        code: b.code,
        status: "finished",
        isTest: false,
        createdAt: T0 + HOUR,
        startedAt: b.startedAt,
        endedAt: b.endsAt,
        endReason: "timeout",
        winnerTeamId: null,
        elapsedMs: HOUR,
        teams: await expectedTeams(b.gameId, [1, 1]),
      },
      {
        code: a.code,
        status: "finished",
        isTest: false,
        createdAt: T0,
        startedAt: a.startedAt,
        endedAt: a.startedAt + 20 * MIN,
        endReason: "completed",
        winnerTeamId: a.teamIds[0],
        elapsedMs: 20 * MIN,
        teams: await expectedTeams(a.gameId, [NON_FINAL_PER_GAME + 1, 0]),
      },
    ];
    expect(body).toEqual({ items: expected });
  });

  it("every item and team has exactly the planned keys, teams by slot", async () => {
    await finishedGame(api, clock, { at: T0, finalMin: 20 });
    await namedGame(api, clock, { at: T0 + HOUR });
    const body = await listAdminGames(adm);
    expect(sortedKeys(body)).toEqual(["items"]);
    expect(body.items).toHaveLength(2);
    for (const item of body.items) {
      expect(sortedKeys(item)).toEqual(ADMIN_GAME_KEYS);
      expect(item.teams.map((t) => t.slot)).toEqual([1, 2]);
      for (const team of item.teams) expect(sortedKeys(team)).toEqual(ADMIN_TEAM_KEYS);
      expect(typeof item.isTest).toBe("boolean");
    }
  });

  it("an abandoned game that had started has both times set, so elapsedMs is their difference", async () => {
    const g = await startedGame(api, clock, { at: T0 });
    clock.setNow(g.startedAt + 7 * MIN);
    await abandonNow(api, g.code);
    const item = (await listAdminGames(adm)).items[0];
    expect(item).toMatchObject({
      code: g.code,
      status: "abandoned",
      startedAt: g.startedAt,
      endedAt: g.startedAt + 7 * MIN,
      elapsedMs: 7 * MIN,
      endReason: null,
      winnerTeamId: null,
    });
  });

  it("a score counts the final state: an undone task doesn't count", async () => {
    const g = await startedGame(api, clock, { at: T0 });
    await play(api, clock, g, [
      { slot: 1, task: 0, min: 1 },
      { slot: 1, task: 1, min: 2 },
      { slot: 1, task: 0, min: 3, action: "undo" },
      { slot: 2, task: 2, min: 4 },
    ]);
    const item = (await listAdminGames(adm)).items[0];
    expect(item?.teams.map((t) => t.score)).toEqual([1, 1]);
  });
});

describe("§9 §10 GET /api/admin/games order and size", () => {
  it("newest createdAt first, regardless of id", async () => {
    const newer = await namedGame(api, clock, { at: T0 + HOUR });
    // Inserted later (higher id) but created earlier.
    await insertHistoryGames([{ code: bulkCode(1), createdAt: T0, startedAt: T0 + 2 * MIN, endedAt: T0 + 30 * MIN }]);
    const older = await gameRow(bulkCode(1));
    expect(older.id).toBeGreaterThan((await gameRow(newer.code)).id);
    const codes = (await listAdminGames(adm)).items.map((g) => g.code);
    expect(codes).toEqual([newer.code, bulkCode(1)]);
  });

  it("the same createdAt: higher id first", async () => {
    const first = await namedGame(api, clock, { at: T0 });
    const second = await namedGame(api, clock, { at: T0 });
    expect((await gameRow(second.code)).id).toBeGreaterThan((await gameRow(first.code)).id);
    const codes = (await listAdminGames(adm)).items.map((g) => g.code);
    expect(codes).toEqual([second.code, first.code]);
  });

  it("has no cap: 30 games (more than history's 25), including test and abandoned games", async () => {
    await insertHistoryGames(
      Array.from({ length: 30 }, (_, i) => ({
        code: bulkCode(i),
        status: i % 3 === 0 ? ("abandoned" as const) : ("finished" as const),
        isTest: i % 5 === 0,
        createdAt: T0 + i * MIN,
        startedAt: T0 + i * MIN + 2 * MIN,
        endedAt: T0 + i * MIN + 20 * MIN,
      })),
    );
    const body = await listAdminGames(adm);
    expect(body.items.map((g) => g.code)).toEqual(Array.from({ length: 30 }, (_, i) => bulkCode(29 - i)));
    expect(body.items.filter((g) => g.isTest)).toHaveLength(6);
    expect(sortedKeys(body)).toEqual(["items"]);
  });
});

describe("§4 GET /api/admin/games sweeps expired games first", () => {
  it("an expired active game is listed as finished by timeout, with the timeout winner", async () => {
    const g = await expiredGame(api, clock, { at: T0, steps: [{ slot: 2, task: 0, min: 5 }] });
    const v0 = (await gameRow(g.code)).version;
    clock.setNow(g.endsAt + MIN);
    const item = (await listAdminGames(adm)).items[0];
    expect(item).toMatchObject({
      code: g.code,
      status: "finished",
      endReason: "timeout",
      startedAt: g.startedAt,
      endedAt: g.endsAt,
      winnerTeamId: g.teamIds[1],
      elapsedMs: HOUR,
    });
    expect(await gameRow(g.code)).toMatchObject({
      status: "finished",
      end_reason: "timeout",
      ended_at: g.endsAt,
      winner_team_id: g.teamIds[1],
      version: v0 + 1,
    });
  });

  it("a game reaching ends_at exactly is swept; one millisecond before, it stays active", async () => {
    const g = await expiredGame(api, clock, { at: T0 });
    const v0 = (await gameRow(g.code)).version;
    clock.setNow(g.endsAt - 1);
    expect((await listAdminGames(adm)).items[0]).toMatchObject({ code: g.code, status: "active", endedAt: null });
    expect((await gameRow(g.code)).version).toBe(v0);
    clock.setNow(g.endsAt);
    expect((await listAdminGames(adm)).items[0]).toMatchObject({ code: g.code, status: "finished", endedAt: g.endsAt });
  });

  it("an expired test game is swept too and listed with isTest true", async () => {
    const g = await expiredGame(api, clock, { at: T0 });
    await markTest(g.code);
    clock.setNow(g.endsAt + MIN);
    expect((await listAdminGames(adm)).items[0]).toMatchObject({ code: g.code, status: "finished", isTest: true });
  });

  it("sweeps at most 5 per request, oldest deadline first; the next request sweeps the rest", async () => {
    const games = [];
    for (let i = 0; i < 7; i++) games.push(await expiredGame(api, clock, { at: T0 + i * 10 * MIN }));
    clock.setNow((games.at(-1)?.endsAt ?? 0) + MIN);

    const first = await listAdminGames(adm);
    const statusOf = async (code: string) => (await gameRow(code)).status;
    const dbStatuses = await Promise.all(games.map((g) => statusOf(g.code)));
    expect(dbStatuses).toEqual(["finished", "finished", "finished", "finished", "finished", "active", "active"]);
    // The response reflects D1 after the sweep.
    for (const g of games) {
      expect(first.items.find((x) => x.code === g.code)?.status).toBe(await statusOf(g.code));
    }

    const second = await listAdminGames(adm);
    expect(second.items.map((x) => x.status)).toEqual(Array(7).fill("finished"));
    for (const g of games) expect(await statusOf(g.code)).toBe("finished");
  });
});
