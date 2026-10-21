// SPEC.md §4: the first request at or after ends_at finalizes the game, so history
// detail must not answer 404 for a timed-out game when finalizing loses a race.
// A test-only D1 wrapper lands a real completion (made before the deadline) just
// before the first timeout commits, so those commits lose.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { commitChange } from "../src/worker/db/games";
import { cookieFor, makeDeps, testApp } from "./helpers/auth";
import { resetDb } from "./helpers/db";
import { gameRow, player, seedRollCatalog, type ActiveGame } from "./helpers/game";
import { historyUrl, startedGame, type DetailBody } from "./helpers/history";

/** env.DB, but a completion at ends_at − 1 commits just before each of the first `losses` timeout commits. */
function racingDb(g: ActiveGame, losses: number): D1Database {
  let raced = 0;
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          // A timeout commit is a batch of exactly one statement (the games UPDATE).
          if (statements.length === 1 && raced < losses) {
            const row = await gameRow(g.code);
            const applied = await commitChange(env.DB, g.gameId, row.version, {
              kind: "complete",
              teamId: g.teamIds[1],
              gameTaskId: g.taskIds[raced]!,
              at: g.endsAt - 1,
              finish: null,
            });
            expect(applied).toBe(true);
            raced += 1;
          }
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

beforeEach(async () => {
  await resetDb();
  await seedRollCatalog();
  ctx = makeDeps();
  g = await startedGame(await player(ctx.deps), ctx);
  ctx.setNow(g.endsAt);
});

describe("§4 history detail when finalizing loses races", () => {
  it("still finalizes and returns the finished game after the sweep and its own first try lose", async () => {
    const res = await testApp(ctx.deps).request(
      historyUrl(g.code),
      { headers: { cookie: await cookieFor("player") } },
      { DB: racingDb(g, 2) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as DetailBody;
    expect(body.game).toMatchObject({ status: "finished", endReason: "timeout", endedAt: g.endsAt });
    // The racing completions (slot 2, before the deadline) decide the timeout winner.
    expect(body.game.winnerTeamId).toBe(g.teamIds[1]);
  });
});

describe("§10 history detail answers 409 busy when every finalize loses", () => {
  it("gives 409 busy and leaves the game unfinished, not 404", async () => {
    // Another write bumps the version just before every timeout commit.
    const alwaysLoses = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (statements.length === 1) {
              await env.DB.prepare("UPDATE games SET version = version + 1 WHERE id = ?").bind(g.gameId).run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const res = await testApp(ctx.deps).request(
      historyUrl(g.code),
      { headers: { cookie: await cookieFor("player") } },
      { DB: alwaysLoses },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "busy", message: expect.any(String) });
    expect((await gameRow(g.code)).status).toBe("active");
  });
});
