// SPEC.md §4 Timeout: the first request that touches the game at or after ends_at finalizes it.
// Most completions wins; tie → earlier last completion; still tied → no winner.
// end_reason=timeout, ended_at=ends_at. §5: complete/undo only before ends_at. §6 version.
import { beforeEach, describe, expect, it } from "vitest";
import { makeDeps } from "./helpers/auth";
import { resetDb } from "./helpers/db";
import {
  abandon,
  activeGame,
  complete,
  eventCount,
  expectApiError,
  gameRow,
  gameState,
  gameUrl,
  player,
  readView,
  seedRollCatalog,
  undo,
  type ActiveGame,
  type Api,
} from "./helpers/game";

const MIN = 60_000;

let ctx: ReturnType<typeof makeDeps>;
let api: Api;
let g: ActiveGame;

beforeEach(async () => {
  await resetDb();
  await seedRollCatalog();
  ctx = makeDeps();
  api = await player(ctx.deps);
  g = await activeGame(api);
});

/** Completes `taskIdx` for `slot` at startedAt + `minutes`. */
async function doneAt(slot: 1 | 2, taskIdx: number, minutes: number) {
  ctx.setNow(g.startedAt + minutes * MIN);
  await readView(await complete(api, g.code, g.taskIds[taskIdx] as number, g.teamIds[slot - 1]));
}

async function expectTimedOut(versionBefore: number, winner: number | null) {
  expect(await gameRow(g.code)).toMatchObject({
    status: "finished",
    end_reason: "timeout",
    ended_at: g.endsAt,
    winner_team_id: winner,
    version: versionBefore + 1,
  });
}

type Op = [name: string, run: () => Promise<Response>];

const writeOps = (): Op[] => [
  ["complete", () => complete(api, g.code, g.taskIds[1] as number, g.teamIds[0])],
  ["undo", () => undo(api, g.code, g.taskIds[0] as number, g.teamIds[0])],
  ["abandon", () => abandon(api, g.code)],
  ["start", () => api.post(gameUrl(g.code, "/start"))],
  ["roll", () => api.post(gameUrl(g.code, "/roll"))],
  ["rename", () => api.patch(gameUrl(g.code, "/teams"), { team1: "Red", team2: "Blue" })],
];
const WRITE_NAMES = writeOps().map(([name]) => name);

describe.each([
  ["at exactly ends_at", 0],
  ["at ends_at + 1", 1],
])("§4 a request %s finalizes first", (_label, offset) => {
  it.each(WRITE_NAMES)("%s: 409 game_over, finished by timeout, version +1, no task_event", async (name) => {
    // Team 1 has one completion (so undo would otherwise be a real change).
    await doneAt(1, 0, 5);
    const v0 = (await gameRow(g.code)).version;
    const events0 = await eventCount(g.gameId);
    ctx.setNow(g.endsAt + offset);
    const op = writeOps().find(([n]) => n === name)?.[1];
    if (!op) throw new Error(name);
    await expectApiError(await op(), 409, "game_over");
    await expectTimedOut(v0, g.teamIds[0]);
    expect(await eventCount(g.gameId)).toBe(events0);
    // The completion the late request tried to make (or undo) didn't happen.
    const view = await readView(await api.get(gameUrl(g.code)));
    expect(view.tasks.find((t) => t.id === g.taskIds[0])?.completedAt[0]).toBe(g.startedAt + 5 * MIN);
    expect(view.tasks.find((t) => t.id === g.taskIds[1])?.completedAt[0]).toBeNull();
    expect(view.teams.map((t) => t.name)).toEqual(["Team 1", "Team 2"]);
    expect(view.version).toBe(v0 + 1);
  });

  it("GET: 200 with the finalized state, version +1", async () => {
    const v0 = (await gameRow(g.code)).version;
    ctx.setNow(g.endsAt + offset);
    const view = await readView(await api.get(gameUrl(g.code)));
    expect(view.version).toBe(v0 + 1);
    expect(view.serverNow).toBe(g.endsAt + offset);
    expect(view.game).toMatchObject({ status: "finished", endReason: "timeout", endedAt: g.endsAt, winnerTeamId: null });
    await expectTimedOut(v0, null);
  });

  it("the final task can't be completed at the deadline even when unlocked", async () => {
    for (const i of [0, 1, 2]) await doneAt(2, i, 10 + i);
    const v0 = (await gameRow(g.code)).version;
    ctx.setNow(g.endsAt + offset);
    await expectApiError(await complete(api, g.code, g.finalTaskId, g.teamIds[1]), 409, "game_over");
    await expectTimedOut(v0, g.teamIds[1]);
    expect((await gameRow(g.code)).end_reason).toBe("timeout");
  });
});

describe("§4 §5 one millisecond before ends_at the game is still live", () => {
  it("complete, undo and GET work at ends_at - 1 without finalizing", async () => {
    ctx.setNow(g.endsAt - 1);
    const v0 = (await gameRow(g.code)).version;
    await readView(await complete(api, g.code, g.taskIds[0] as number, g.teamIds[0]));
    await readView(await undo(api, g.code, g.taskIds[0] as number, g.teamIds[0]));
    const view = await readView(await api.get(gameUrl(g.code)));
    expect(view.game.status).toBe("active");
    expect(view.version).toBe(v0 + 2);
  });
});

describe("§4 timeout winner", () => {
  it("most completions wins (even with a later last completion)", async () => {
    await doneAt(1, 0, 10);
    await doneAt(1, 1, 50);
    await doneAt(2, 0, 5);
    const v0 = (await gameRow(g.code)).version;
    ctx.setNow(g.endsAt);
    const view = await readView(await api.get(gameUrl(g.code)));
    expect(view.game.winnerTeamId).toBe(g.teamIds[0]);
    await expectTimedOut(v0, g.teamIds[0]);
  });

  it("equal counts: team 2 with the earlier last completion wins", async () => {
    await doneAt(1, 0, 2);
    await doneAt(2, 0, 3);
    await doneAt(2, 1, 20);
    await doneAt(1, 1, 21);
    const v0 = (await gameRow(g.code)).version;
    ctx.setNow(g.endsAt);
    expect((await readView(await api.get(gameUrl(g.code)))).game.winnerTeamId).toBe(g.teamIds[1]);
    await expectTimedOut(v0, g.teamIds[1]);
  });

  it("equal counts: team 1 with the earlier last completion wins", async () => {
    // Team 2 started earlier, but team 1's last completion (32) beats team 2's (35).
    await doneAt(2, 2, 1);
    await doneAt(1, 0, 30);
    await doneAt(1, 1, 32);
    await doneAt(2, 0, 35);
    const v0 = (await gameRow(g.code)).version;
    ctx.setNow(g.endsAt + 1);
    expect((await readView(await api.get(gameUrl(g.code)))).game.winnerTeamId).toBe(g.teamIds[0]);
    await expectTimedOut(v0, g.teamIds[0]);
  });

  it("equal counts and equal last completion: a true tie with a NULL winner", async () => {
    await doneAt(1, 0, 4);
    await doneAt(2, 1, 9);
    await doneAt(1, 2, 15);
    await doneAt(2, 0, 15);
    const v0 = (await gameRow(g.code)).version;
    ctx.setNow(g.endsAt);
    const view = await readView(await api.get(gameUrl(g.code)));
    expect(view.game).toMatchObject({ status: "finished", endReason: "timeout", winnerTeamId: null });
    await expectTimedOut(v0, null);
  });

  it("0–0 is a tie with a NULL winner", async () => {
    const v0 = (await gameRow(g.code)).version;
    ctx.setNow(g.endsAt);
    await readView(await api.get(gameUrl(g.code)));
    await expectTimedOut(v0, null);
  });

  it("an undo before the deadline changes the result", async () => {
    // Team 1: A@1, B@5; team 2: A@3. Team 1 would win 2–1.
    await doneAt(1, 0, 1);
    await doneAt(1, 1, 5);
    await doneAt(2, 0, 3);
    // Undo team 1's A: now 1–1, team 1's last is 5, team 2's is 3, so team 2 wins.
    ctx.setNow(g.startedAt + 20 * MIN);
    await readView(await undo(api, g.code, g.taskIds[0] as number, g.teamIds[0]));
    const v0 = (await gameRow(g.code)).version;
    ctx.setNow(g.endsAt);
    expect((await readView(await api.get(gameUrl(g.code)))).game.winnerTeamId).toBe(g.teamIds[1]);
    await expectTimedOut(v0, g.teamIds[1]);
  });

  it("a completion attempted at the deadline doesn't count toward the result", async () => {
    await doneAt(2, 0, 10);
    ctx.setNow(g.endsAt);
    await expectApiError(await complete(api, g.code, g.taskIds[0] as number, g.teamIds[0]), 409, "game_over");
    expect((await gameRow(g.code)).winner_team_id).toBe(g.teamIds[1]);
  });
});

describe("§4 finalize happens exactly once", () => {
  it("two simultaneous GETs after expiry give exactly one version bump", async () => {
    await doneAt(1, 0, 1);
    const v0 = (await gameRow(g.code)).version;
    ctx.setNow(g.endsAt + 5);
    const [a, b] = await Promise.all([api.get(gameUrl(g.code)), api.get(gameUrl(g.code))]);
    const va = await readView(a);
    const vb = await readView(b);
    expect(va.version).toBe(v0 + 1);
    expect(vb.version).toBe(v0 + 1);
    for (const v of [va, vb]) {
      expect(v.game).toMatchObject({ status: "finished", endReason: "timeout", endedAt: g.endsAt, winnerTeamId: g.teamIds[0] });
    }
    await expectTimedOut(v0, g.teamIds[0]);
  });

  it("a GET and a complete together after expiry: one bump, the complete gets 409 game_over", async () => {
    const v0 = (await gameRow(g.code)).version;
    ctx.setNow(g.endsAt);
    const [getRes, completeRes] = await Promise.all([
      api.get(gameUrl(g.code)),
      complete(api, g.code, g.taskIds[0] as number, g.teamIds[0]),
    ]);
    expect((await readView(getRes)).version).toBe(v0 + 1);
    await expectApiError(completeRes, 409, "game_over");
    await expectTimedOut(v0, null);
    expect(await eventCount(g.gameId)).toBe(0);
  });

  it("later requests never re-finalize or move ended_at", async () => {
    const v0 = (await gameRow(g.code)).version;
    ctx.setNow(g.endsAt);
    await readView(await api.get(gameUrl(g.code)));
    const after = await gameState(g.gameId);
    ctx.advance(2 * 3_600_000);
    await readView(await api.get(gameUrl(g.code)));
    await expectApiError(await abandon(api, g.code), 409, "game_over");
    expect(await gameState(g.gameId)).toEqual(after);
    await expectTimedOut(v0, null);
  });
});
