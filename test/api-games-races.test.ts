// SPEC.md §4 timeout and §10 `busy`, under forced races. A test-only D1 wrapper runs
// interfering SQL just before chosen batches, so the interleavings are deterministic.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { commitChange } from "../src/worker/db/games";
import { cookieFor, makeDeps, testApp } from "./helpers/auth";
import { resetDb } from "./helpers/db";
import {
  activeGame,
  expectApiError,
  gameRow,
  gameState,
  gameUrl,
  player,
  readView,
  seedRollCatalog,
  taskUrl,
  type ActiveGame,
} from "./helpers/game";

/** env.DB, but `beforeBatch(n)` runs before the n-th batch (0-based) of the request. */
function interceptingDb(beforeBatch: (n: number) => Promise<void>): D1Database {
  let calls = 0;
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          await beforeBatch(calls++);
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

let ctx: ReturnType<typeof makeDeps>;
let g: ActiveGame;
let cookie: string;

beforeEach(async () => {
  await resetDb();
  await seedRollCatalog();
  ctx = makeDeps();
  g = await activeGame(await player(ctx.deps));
  cookie = await cookieFor("player");
});

function send(db: D1Database, method: string, path: string, body?: unknown) {
  return testApp(ctx.deps).request(
    path,
    {
      method,
      headers: body === undefined ? { cookie } : { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { DB: db },
  );
}

describe("§10 409 busy after three lost races", () => {
  it("a complete that loses every commit gets 409 busy and writes nothing", async () => {
    ctx.advance(60_000);
    const before = await gameState(g.gameId);
    // Another write lands just before every batch, so each commit's version is stale.
    const db = interceptingDb(async () => {
      await env.DB.prepare("UPDATE games SET version = version + 1 WHERE id = ?").bind(g.gameId).run();
    });
    const res = await send(db, "POST", taskUrl(g.code, g.taskIds[0]!, "complete"), { teamId: g.teamIds[0] });
    await expectApiError(res, 409, "busy");
    const after = await gameState(g.gameId);
    expect(after.events).toEqual(before.events);
    expect(after.teamTasks).toEqual(before.teamTasks);
    expect(after.game?.status).toBe("active");
  });
});

describe("§4 timeout still wins when finalizing loses a race", () => {
  // Request batches: 0 = snapshot load, 1 = the timeout commit. Before batch 1, a
  // complete made just before the deadline commits first, so that timeout commit fails.
  function raceBeforeTimeoutCommit() {
    return interceptingDb(async (n) => {
      if (n !== 1) return;
      const row = await gameRow(g.code);
      const applied = await commitChange(env.DB, g.gameId, row.version, {
        kind: "complete",
        teamId: g.teamIds[1],
        gameTaskId: g.taskIds[0]!,
        at: g.endsAt - 1,
        finish: null,
      });
      expect(applied).toBe(true);
    });
  }

  it("an abandon at ends_at finalizes by timeout instead of abandoning", async () => {
    ctx.setNow(g.endsAt);
    await expectApiError(await send(raceBeforeTimeoutCommit(), "POST", gameUrl(g.code, "/abandon")), 409, "game_over");
    const row = await gameRow(g.code);
    expect(row.status).toBe("finished");
    expect(row.end_reason).toBe("timeout");
    expect(row.ended_at).toBe(g.endsAt);
    // The completion that won the race counts: slot 2 has 1 task, slot 1 has 0.
    expect(row.winner_team_id).toBe(g.teamIds[1]);
  });

  it("a GET at ends_at returns the finished game, not an expired active one", async () => {
    ctx.setNow(g.endsAt);
    const view = await readView(await send(raceBeforeTimeoutCommit(), "GET", gameUrl(g.code)));
    expect(view.game.status).toBe("finished");
    expect(view.game.endReason).toBe("timeout");
    expect(view.game.winnerTeamId).toBe(g.teamIds[1]);
  });
});

describe("§5 complete/undo check the game before the body", () => {
  it.each(["complete", "undo"] as const)("%s with a bad teamId on an unknown code gives 404", async (action) => {
    const res = await send(env.DB, "POST", taskUrl("ZZZZZ", 1, action), { teamId: "nope" });
    await expectApiError(res, 404, "not_found");
  });

  it.each(["complete", "undo"] as const)("%s with a bad teamId on a timed-out game gives 409 game_over", async (action) => {
    ctx.setNow(g.endsAt);
    const res = await send(env.DB, "POST", taskUrl(g.code, g.taskIds[0]!, action), {});
    await expectApiError(res, 409, "game_over");
  });

  it.each(["complete", "undo"] as const)("%s with a bad teamId on an active game still gives 422", async (action) => {
    ctx.advance(60_000);
    const res = await send(env.DB, "POST", taskUrl(g.code, g.taskIds[0]!, action), { teamId: 1.5 });
    await expectApiError(res, 422, "validation");
  });
});

describe("§4 the commit itself refuses player actions at or after ends_at", () => {
  it("a complete committed at ends_at writes nothing, not even the task or event", async () => {
    const before = await gameState(g.gameId);
    const applied = await commitChange(env.DB, g.gameId, (await gameRow(g.code)).version, {
      kind: "complete",
      teamId: g.teamIds[0],
      gameTaskId: g.taskIds[0]!,
      at: g.endsAt,
      finish: null,
    });
    expect(applied).toBe(false);
    expect(await gameState(g.gameId)).toEqual(before);
  });

  it("an abandon committed at ends_at writes nothing", async () => {
    const before = await gameState(g.gameId);
    const applied = await commitChange(env.DB, g.gameId, (await gameRow(g.code)).version, { kind: "abandon", at: g.endsAt });
    expect(applied).toBe(false);
    expect(await gameState(g.gameId)).toEqual(before);
  });
});
