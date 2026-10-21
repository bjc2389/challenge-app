// SPEC.md §9 /history (finished and abandoned games, newest first, abandoned labeled;
// records exclude abandoned games; test games hidden entirely) and §10 GET /api/history
// (player session; errors are {error, message}). Approved M5 plan: newest first by
// ended_at desc then id desc, capped at 25 with hasMore; records over all eligible games.
import { beforeEach, describe, expect, it } from "vitest";
import { cookieFor, expectError, makeDeps, testApp, withCookie } from "./helpers/auth";
import { T0, resetDb } from "./helpers/db";
import { anonymous, gameRow, gameUrl, player, readView, seedRollCatalog, type Api } from "./helpers/game";
import {
  HOUR,
  MIN,
  abandonNow,
  bulkCode,
  getList,
  historyUrl,
  insertHistoryGames,
  markTest,
  namedGame,
  redsBluesGame,
  rolledNamedGame,
  startedGame,
  timedOutGame,
  type BulkGame,
  type Clock,
} from "./helpers/history";

let clock: Clock;
let api: Api;

beforeEach(async () => {
  await resetDb();
  await seedRollCatalog();
  clock = makeDeps();
  api = await player(clock.deps);
});

describe("§3 §10 GET /api/history needs a session", () => {
  it("401 {error, message} without a cookie", async () => {
    await expectError(await anonymous(clock.deps, "GET", historyUrl()), 401, "unauthorized", "Log in to continue");
  });

  it("an admin session also has player access (200)", async () => {
    const res = await testApp(clock.deps).request(historyUrl(), withCookie(await cookieFor("admin")));
    expect(res.status).toBe(200);
  });
});

describe("§9 §10 GET /api/history with no games", () => {
  it("is empty, hasMore false, records empty", async () => {
    expect(await getList(api)).toEqual({
      items: [],
      hasMore: false,
      records: { fastestWin: null, fastestPuzzle: null, gamesPlayed: 0 },
    });
  });
});

describe("§9 GET /api/history: a mixed set of games", () => {
  /**
   * A: Reds 4 – 3 Blues completion win (created T0, started T0+2m, ended T0+32m).
   * C: abandoned in setup at T0+40m.
   * B: timeout, Greens 2 – 1 Golds (created T0+50m, started T0+52m, ended T0+112m).
   * D: abandoned while active at T0+130m (started T0+122m), Pinks 1 – 0 Greys.
   * Then games left in setup, rolled and active (not expired) at T0+140m..; listed at T0+150m.
   */
  async function seedMixed() {
    const a = await redsBluesGame(api, clock, T0);
    const c = await namedGame(api, clock, { at: T0 + 40 * MIN, names: ["Ambers", "Teals"] });
    await abandonNow(api, c.code);
    const b = await timedOutGame(api, clock, {
      at: T0 + 50 * MIN,
      names: ["Greens", "Golds"],
      steps: [
        { slot: 1, task: 0, min: 10 },
        { slot: 2, task: 1, min: 15 },
        { slot: 1, task: 1, min: 20 },
      ],
    });
    const d = await startedGame(api, clock, { at: T0 + 120 * MIN, names: ["Pinks", "Greys"] });
    clock.setNow(d.startedAt + 3 * MIN);
    await readView(await api.post(gameUrl(d.code, `/tasks/${d.taskIds[0]}/complete`), { teamId: d.teamIds[0] }));
    clock.setNow(T0 + 130 * MIN);
    await abandonNow(api, d.code);
    const setup = await namedGame(api, clock, { at: T0 + 140 * MIN });
    const rolled = await rolledNamedGame(api, clock, { at: T0 + 141 * MIN });
    const active = await startedGame(api, clock, { at: T0 + 143 * MIN });
    clock.setNow(T0 + 150 * MIN);
    return { a, b, c, d, setup, rolled, active };
  }

  it("lists finished and abandoned games newest first with full items", async () => {
    const { a, b, c, d } = await seedMixed();
    const cRow = await gameRow(c.code);
    const cTeams = (await readView(await api.get(gameUrl(c.code)))).teams;
    const list = await getList(api);
    expect(list.items).toEqual([
      {
        code: d.code,
        status: "abandoned",
        startedAt: d.startedAt,
        endedAt: T0 + 130 * MIN,
        elapsedMs: T0 + 130 * MIN - d.startedAt,
        endReason: null,
        winnerTeamId: null,
        teams: [
          { id: d.teamIds[0], slot: 1, name: "Pinks", score: 1 },
          { id: d.teamIds[1], slot: 2, name: "Greys", score: 0 },
        ],
      },
      {
        code: b.code,
        status: "finished",
        startedAt: b.startedAt,
        endedAt: b.endsAt,
        elapsedMs: HOUR,
        endReason: "timeout",
        winnerTeamId: b.teamIds[0],
        teams: [
          { id: b.teamIds[0], slot: 1, name: "Greens", score: 2 },
          { id: b.teamIds[1], slot: 2, name: "Golds", score: 1 },
        ],
      },
      {
        code: c.code,
        status: "abandoned",
        startedAt: null,
        endedAt: T0 + 40 * MIN,
        elapsedMs: null,
        endReason: null,
        winnerTeamId: null,
        teams: [
          { id: cTeams[0]!.id, slot: 1, name: "Ambers", score: 0 },
          { id: cTeams[1]!.id, slot: 2, name: "Teals", score: 0 },
        ],
      },
      {
        code: a.code,
        status: "finished",
        startedAt: a.startedAt,
        endedAt: a.startedAt + 30 * MIN,
        elapsedMs: 30 * MIN,
        endReason: "completed",
        winnerTeamId: a.teamIds[0],
        teams: [
          { id: a.teamIds[0], slot: 1, name: "Reds", score: 4 },
          { id: a.teamIds[1], slot: 2, name: "Blues", score: 3 },
        ],
      },
    ]);
    expect(cRow.ended_at).toBe(T0 + 40 * MIN);
    expect(list.hasMore).toBe(false);
  });

  it("setup, rolled and active games are never listed", async () => {
    const { setup, rolled, active } = await seedMixed();
    const codes = (await getList(api)).items.map((i) => i.code);
    for (const code of [setup.code, rolled.code, active.code]) expect(codes).not.toContain(code);
    expect(codes).toHaveLength(4);
  });

  it("records: fastest win and fastest puzzle (the redo counts); games played excludes abandoned", async () => {
    const { a } = await seedMixed();
    expect((await getList(api)).records).toEqual({
      fastestWin: { code: a.code, teamName: "Reds", ms: 30 * MIN, endedAt: a.startedAt + 30 * MIN },
      // Reds' last non-final completion is the redo at +20, the final at +30.
      fastestPuzzle: { code: a.code, teamName: "Reds", ms: 10 * MIN, endedAt: a.startedAt + 30 * MIN },
      gamesPlayed: 2,
    });
  });

  it("a test game is absent from items and records", async () => {
    const { a, b } = await seedMixed();
    await markTest(a.code);
    const list = await getList(api);
    expect(list.items.map((i) => i.code)).not.toContain(a.code);
    expect(list.items).toHaveLength(3);
    expect(list.records).toEqual({ fastestWin: null, fastestPuzzle: null, gamesPlayed: 1 });
    await markTest(b.code);
    expect((await getList(api)).records.gamesPlayed).toBe(0);
  });

  it("listing writes nothing when no game is expired", async () => {
    const { a, b, c, d, setup, rolled, active } = await seedMixed();
    const codes = [a, b, c, d, setup, rolled, active].map((g) => g.code);
    const before = await Promise.all(codes.map(gameRow));
    await getList(api);
    expect(await Promise.all(codes.map(gameRow))).toEqual(before);
  });
});

describe("§9 ordering: ended_at desc, then id desc", () => {
  it("games ending in the same ms list the later-inserted (higher id) first", async () => {
    await insertHistoryGames([
      { code: bulkCode(1), startedAt: T0, endedAt: T0 + 20 * MIN },
      { code: bulkCode(2), startedAt: T0, endedAt: T0 + 20 * MIN },
      { code: bulkCode(3), startedAt: T0, endedAt: T0 + 10 * MIN },
      { code: bulkCode(4), status: "abandoned", startedAt: T0, endedAt: T0 + 30 * MIN },
    ]);
    const ids = await Promise.all([1, 2].map((i) => gameRow(bulkCode(i)).then((r) => r.id)));
    expect(ids[1]).toBeGreaterThan(ids[0]!);
    expect((await getList(api)).items.map((i) => i.code)).toEqual([bulkCode(4), bulkCode(2), bulkCode(1), bulkCode(3)]);
  });
});

describe("§9 the list cap (25) and hasMore; records over every eligible game", () => {
  /** `n` completion wins, game i ending i hours after T0 (so higher i is newer). */
  const wins = (n: number, from = 0): BulkGame[] =>
    Array.from({ length: n }, (_, k) => {
      const i = from + k;
      return { code: bulkCode(i), startedAt: T0 + i * HOUR, endedAt: T0 + i * HOUR + 40 * MIN };
    });

  it("26 finished games: 25 newest items, hasMore true, gamesPlayed 26", async () => {
    await insertHistoryGames(wins(26));
    const list = await getList(api);
    expect(list.items).toHaveLength(25);
    expect(list.hasMore).toBe(true);
    expect(list.items.map((i) => i.code)).toEqual(Array.from({ length: 25 }, (_, k) => bulkCode(25 - k)));
    expect(list.records.gamesPlayed).toBe(26);
  });

  it("exactly 25 games: hasMore false", async () => {
    await insertHistoryGames(wins(25));
    const list = await getList(api);
    expect(list.items).toHaveLength(25);
    expect(list.hasMore).toBe(false);
  });

  it("records come from a game beyond the cap", async () => {
    // The oldest game (index 0) is both the fastest win and the fastest puzzle.
    const games = wins(26);
    games[0] = {
      code: bulkCode(0),
      startedAt: T0,
      endedAt: T0 + 12 * MIN,
      names: ["Ambers", "Teals"],
      winnerSlot: 2,
      puzzle: { slot: 2, lastNonFinalAt: T0 + 11 * MIN, finalAt: T0 + 12 * MIN },
    };
    games[5] = { ...games[5]!, puzzle: { slot: 1, lastNonFinalAt: games[5]!.startedAt + 30 * MIN, finalAt: games[5]!.endedAt } };
    await insertHistoryGames(games);
    const list = await getList(api);
    expect(list.items.map((i) => i.code)).not.toContain(bulkCode(0));
    expect(list.records).toEqual({
      fastestWin: { code: bulkCode(0), teamName: "Teals", ms: 12 * MIN, endedAt: T0 + 12 * MIN },
      fastestPuzzle: { code: bulkCode(0), teamName: "Teals", ms: MIN, endedAt: T0 + 12 * MIN },
      gamesPlayed: 26,
    });
  });

  it("abandoned and test games beyond the cap don't count; test games don't take list slots", async () => {
    await insertHistoryGames([
      ...wins(24),
      { code: bulkCode(100), status: "abandoned", startedAt: T0 + 100 * HOUR, endedAt: T0 + 100 * HOUR + MIN },
      { code: bulkCode(101), isTest: true, startedAt: T0 + 101 * HOUR, endedAt: T0 + 101 * HOUR + MIN },
      { code: bulkCode(102), isTest: true, status: "abandoned", startedAt: T0 + 102 * HOUR, endedAt: T0 + 102 * HOUR + MIN },
    ]);
    const list = await getList(api);
    // 24 wins + 1 abandoned = 25 visible; the two test games are hidden.
    expect(list.items).toHaveLength(25);
    expect(list.hasMore).toBe(false);
    expect(list.items[0]).toMatchObject({ code: bulkCode(100), status: "abandoned" });
    expect(list.records.gamesPlayed).toBe(24);
    expect(list.records.fastestWin?.ms).toBe(40 * MIN);
  });
});
