// SPEC.md §4 Timeout: "History endpoints also sweep and finalize expired games (M5)."
// The timeout result is the usual one (most tasks; then the earlier last completion; then
// a tie), with end_reason=timeout and ended_at=ends_at, and §10 version +1 exactly once.
// Approved M5 plan: both history endpoints sweep first, up to 5 games per request, oldest
// ends_at first, test games included; sweepExpiredGames(db, now, limit?) returns the count.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { sweepExpiredGames } from "../src/worker/db/games";
import { makeDeps } from "./helpers/auth";
import { T0, resetDb } from "./helpers/db";
import { gameRow, gameState, player, seedRollCatalog, type ActiveGame, type Api } from "./helpers/game";
import {
  HOUR,
  MIN,
  abandonNow,
  expiredGame,
  getDetail,
  getList,
  historyUrl,
  markTest,
  namedGame,
  redsBluesGame,
  rolledNamedGame,
  versions,
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

async function expectTimedOut(g: ActiveGame, version: number, winner: number | null) {
  expect(await gameRow(g.code)).toMatchObject({
    status: "finished",
    end_reason: "timeout",
    ended_at: g.endsAt,
    winner_team_id: winner,
    version,
  });
}

/** `n` active games started 10 minutes apart from T0 (so ends_at ascends with the index). */
async function expiredGames(n: number): Promise<ActiveGame[]> {
  const out: ActiveGame[] = [];
  for (let i = 0; i < n; i++) out.push(await expiredGame(api, clock, { at: T0 + i * 10 * MIN }));
  return out;
}

type Via = "list" | "detail";

/** Hits a history endpoint. For "detail" it asks for `otherCode`, a different finished game. */
async function hit(via: Via, otherCode: string) {
  if (via === "list") return getList(api);
  return getDetail(api, otherCode);
}

describe.each<[Via]>([["list"], ["detail"]])("§4 the history %s request sweeps expired games first", (via) => {
  let other: string;

  beforeEach(async () => {
    // A finished game to ask for when sweeping through the detail endpoint.
    other = (await redsBluesGame(api, clock, T0 - 5 * HOUR)).code;
  });

  it("an expired game becomes finished/timeout with the right winner, ended_at = ends_at, version +1", async () => {
    const g = await expiredGame(api, clock, {
      at: T0,
      steps: [
        { slot: 2, task: 0, min: 5 },
        { slot: 2, task: 1, min: 6 },
        { slot: 1, task: 0, min: 7 },
      ],
    });
    const v0 = (await gameRow(g.code)).version;
    clock.setNow(g.endsAt + 2 * HOUR);
    await hit(via, other);
    await expectTimedOut(g, v0 + 1, g.teamIds[1]);
  });

  it("the timeout tie-break applies: equal counts, the earlier last completion wins", async () => {
    const g = await expiredGame(api, clock, {
      at: T0,
      steps: [
        { slot: 1, task: 0, min: 2 },
        { slot: 2, task: 0, min: 3 },
        { slot: 2, task: 1, min: 20 },
        { slot: 1, task: 1, min: 21 },
      ],
    });
    const v0 = (await gameRow(g.code)).version;
    clock.setNow(g.endsAt);
    await hit(via, other);
    await expectTimedOut(g, v0 + 1, g.teamIds[1]);
  });

  it("a true tie is finalized with no winner", async () => {
    const g = await expiredGame(api, clock, { at: T0 });
    const v0 = (await gameRow(g.code)).version;
    clock.setNow(g.endsAt);
    await hit(via, other);
    await expectTimedOut(g, v0 + 1, null);
  });

  it("exactly at ends_at the game is swept", async () => {
    const g = await expiredGame(api, clock, { at: T0, steps: [{ slot: 1, task: 0, min: 1 }] });
    const v0 = (await gameRow(g.code)).version;
    clock.setNow(g.endsAt);
    await hit(via, other);
    await expectTimedOut(g, v0 + 1, g.teamIds[0]);
  });

  it("at ends_at − 1 the game is untouched", async () => {
    const g = await expiredGame(api, clock, { at: T0, steps: [{ slot: 1, task: 0, min: 1 }] });
    const before = await gameState(g.gameId);
    clock.setNow(g.endsAt - 1);
    await hit(via, other);
    expect(await gameState(g.gameId)).toEqual(before);
  });

  it("an expired test game is finalized in D1 but stays hidden", async () => {
    const g = await expiredGame(api, clock, { at: T0, steps: [{ slot: 2, task: 0, min: 1 }] });
    await markTest(g.code);
    const v0 = (await gameRow(g.code)).version;
    clock.setNow(g.endsAt);
    await hit(via, other);
    await expectTimedOut(g, v0 + 1, g.teamIds[1]);
    const list = await getList(api);
    expect(list.items.map((i) => i.code)).not.toContain(g.code);
    expect(list.records.gamesPlayed).toBe(1);
    expect((await api.get(historyUrl(g.code))).status).toBe(404);
  });

  it("6 expired games: 5 swept (oldest ends_at first), then the 6th on the next request", async () => {
    const games = await expiredGames(6);
    const v0 = await versions(games.map((g) => g.code));
    clock.setNow(games[5]!.endsAt + MIN);
    await hit(via, other);
    for (const g of games.slice(0, 5)) await expectTimedOut(g, v0[g.code]! + 1, null);
    expect(await gameRow(games[5]!.code)).toMatchObject({ status: "active", version: v0[games[5]!.code] });
    await hit(via, other);
    await expectTimedOut(games[5]!, v0[games[5]!.code]! + 1, null);
  });

  it("a repeated sweep doesn't bump any version", async () => {
    const games = await expiredGames(2);
    clock.setNow(games[1]!.endsAt);
    await hit(via, other);
    const after = await versions([...games.map((g) => g.code), other]);
    clock.advance(HOUR);
    await hit(via, other);
    await hit(via, other);
    expect(await versions([...games.map((g) => g.code), other])).toEqual(after);
  });

  it("setup, rolled, abandoned, finished and not-yet-expired active games are untouched", async () => {
    const expired = await expiredGame(api, clock, { at: T0 });
    const live = await expiredGame(api, clock, { at: T0 + 30 * MIN });
    const setup = await namedGame(api, clock, { at: T0 + 40 * MIN });
    const rolled = await rolledNamedGame(api, clock, { at: T0 + 41 * MIN });
    const abandoned = await namedGame(api, clock, { at: T0 + 45 * MIN });
    await abandonNow(api, abandoned.code);
    const ids = [live.gameId, setup.gameId, rolled.gameId, abandoned.gameId, (await gameRow(other)).id];
    const before = await Promise.all(ids.map(gameState));
    clock.setNow(expired.endsAt);
    await hit(via, other);
    expect((await gameRow(expired.code)).status).toBe("finished");
    expect(await Promise.all(ids.map(gameState))).toEqual(before);
  });
});

describe("§4 through the list: swept games appear as finished/timeout", () => {
  it("the first response already shows the swept game", async () => {
    const g = await expiredGame(api, clock, { at: T0, steps: [{ slot: 1, task: 0, min: 1 }] });
    clock.setNow(g.endsAt + 1);
    const list = await getList(api);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      code: g.code,
      status: "finished",
      endReason: "timeout",
      endedAt: g.endsAt,
      winnerTeamId: g.teamIds[0],
      elapsedMs: HOUR,
    });
    expect(list.records.gamesPlayed).toBe(1);
  });

  it("6 expired: the first list shows 5, the second shows 6", async () => {
    const games = await expiredGames(6);
    clock.setNow(games[5]!.endsAt);
    expect((await getList(api)).items.map((i) => i.code)).toEqual(games.slice(0, 5).reverse().map((g) => g.code));
    expect((await getList(api)).items.map((i) => i.code)).toEqual(games.slice().reverse().map((g) => g.code));
  });
});

describe("§4 detail finalizes its own game even when the sweep limit is used up", () => {
  it("6 expired games: detail of the newest (the one the sweep skips) is 200 finished/timeout", async () => {
    const games = await expiredGames(6);
    const last = games[5]!;
    const v0 = await versions(games.map((g) => g.code));
    clock.setNow(last.endsAt);
    const detail = await getDetail(api, last.code);
    expect(detail.game).toMatchObject({ status: "finished", endReason: "timeout", endedAt: last.endsAt, elapsedMs: HOUR });
    for (const g of games) await expectTimedOut(g, v0[g.code]! + 1, null);
  });

  it("works with a lowercase code too", async () => {
    const games = await expiredGames(6);
    const last = games[5]!;
    clock.setNow(last.endsAt);
    const detail = await getDetail(api, last.code.toLowerCase());
    expect(detail.game).toMatchObject({ code: last.code, status: "finished", endReason: "timeout" });
  });
});

describe("§4 sweepExpiredGames(db, now, limit?)", () => {
  it("returns 5, then 1, then 0 for 6 expired games", async () => {
    const games = await expiredGames(6);
    const now = games[5]!.endsAt;
    expect(await sweepExpiredGames(env.DB, now)).toBe(5);
    expect((await gameRow(games[5]!.code)).status).toBe("active");
    expect(await sweepExpiredGames(env.DB, now)).toBe(1);
    expect(await sweepExpiredGames(env.DB, now)).toBe(0);
    for (const g of games) expect((await gameRow(g.code)).status).toBe("finished");
  });

  it("sweeps the oldest ends_at first", async () => {
    // Insertion order differs from ends_at order: the later-ending game is created first
    // (the injected clock moves back for the second one).
    const late = await expiredGame(api, clock, { at: T0 + 30 * MIN });
    const early = await expiredGame(api, clock, { at: T0 });
    clock.setNow(late.endsAt);
    expect(await sweepExpiredGames(env.DB, late.endsAt, 1)).toBe(1);
    expect((await gameRow(early.code)).status).toBe("finished");
    expect((await gameRow(late.code)).status).toBe("active");
  });

  it("honors a custom limit", async () => {
    const games = await expiredGames(3);
    const now = games[2]!.endsAt;
    expect(await sweepExpiredGames(env.DB, now, 2)).toBe(2);
    expect(await sweepExpiredGames(env.DB, now, 2)).toBe(1);
  });

  it("includes test games", async () => {
    const g = await expiredGame(api, clock, { at: T0 });
    await markTest(g.code);
    expect(await sweepExpiredGames(env.DB, g.endsAt)).toBe(1);
    expect(await gameRow(g.code)).toMatchObject({ status: "finished", end_reason: "timeout", is_test: 1 });
  });

  it("uses ends_at <= now: at ends_at − 1 nothing is swept", async () => {
    const g = await expiredGame(api, clock, { at: T0 });
    expect(await sweepExpiredGames(env.DB, g.endsAt - 1)).toBe(0);
    expect(await sweepExpiredGames(env.DB, g.endsAt)).toBe(1);
  });

  it("finalizes through the timeout commit: winner, ended_at = ends_at, version +1, no task_event", async () => {
    const g = await expiredGame(api, clock, {
      at: T0,
      steps: [
        { slot: 1, task: 0, min: 4 },
        { slot: 1, task: 1, min: 9 },
        { slot: 2, task: 0, min: 2 },
      ],
    });
    const before = await gameState(g.gameId);
    expect(await sweepExpiredGames(env.DB, g.endsAt + 3 * HOUR)).toBe(1);
    await expectTimedOut(g, before.game!.version + 1, g.teamIds[0]);
    const after = await gameState(g.gameId);
    expect(after.events).toEqual(before.events);
    expect(after.teamTasks).toEqual(before.teamTasks);
  });
});
