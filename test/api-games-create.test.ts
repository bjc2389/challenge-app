// SPEC.md §4 Create, §6 serverNow/version, §8 games/teams, §10 POST /api/games.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { makeDeps, NOW } from "./helpers/auth";
import { insertGame, resetDb } from "./helpers/db";
import {
  DURATION_MS,
  anonymous,
  expectApiError,
  gameCount,
  gameRow,
  player,
  readView,
  seqRandom,
  teamRows,
  type Api,
} from "./helpers/game";

const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;

let ctx: ReturnType<typeof makeDeps>;
let api: Api;

beforeEach(async () => {
  await resetDb();
  ctx = makeDeps();
  api = await player(ctx.deps);
});

describe("§3 §10 POST /api/games auth", () => {
  it("401 without a session, and nothing is created", async () => {
    await expectApiError(await anonymous(ctx.deps, "POST", "/api/games"), 401, "unauthorized");
    expect(await gameCount()).toBe(0);
  });
});

describe("§4 §6 POST /api/games creates a game in setup", () => {
  it("returns 201 with the full GameView", async () => {
    const view = await readView(await api.post("/api/games"), 201);
    expect(view).toEqual({
      serverNow: NOW,
      version: 0,
      game: {
        code: expect.stringMatching(CODE_RE),
        status: "setup",
        createdAt: NOW,
        rolledAt: null,
        startedAt: null,
        endsAt: null,
        endedAt: null,
        endReason: null,
        winnerTeamId: null,
        durationMs: DURATION_MS,
      },
      teams: [
        { id: expect.any(Number), slot: 1, name: "Team 1", score: 0, finalUnlocked: expect.any(Boolean), lastCompletedAt: null },
        { id: expect.any(Number), slot: 2, name: "Team 2", score: 0, finalUnlocked: expect.any(Boolean), lastCompletedAt: null },
      ],
      tasks: [],
    });
    expect(view.teams[0]?.id).not.toBe(view.teams[1]?.id);
  });

  it("writes the games row (version 0, created_at=now, not a test game) and two teams", async () => {
    ctx.setNow(NOW + 12_345);
    const view = await readView(await api.post("/api/games"), 201);
    const row = await gameRow(view.game.code);
    expect(row).toMatchObject({
      code: view.game.code,
      status: "setup",
      is_test: 0,
      version: 0,
      created_at: NOW + 12_345,
      rolled_at: null,
      started_at: null,
      ends_at: null,
      ended_at: null,
      end_reason: null,
      winner_team_id: null,
    });
    expect(view.serverNow).toBe(NOW + 12_345);
    expect(view.game.createdAt).toBe(NOW + 12_345);
    const teams = await teamRows(row.id);
    expect(teams.map((t) => [t.id, t.slot, t.name])).toEqual([
      [view.teams[0]?.id, 1, "Team 1"],
      [view.teams[1]?.id, 2, "Team 2"],
    ]);
  });

  it("ignores the request body", async () => {
    const view = await readView(
      await api.post("/api/games", { code: "ZZZZZ", status: "active", team1: "Red", version: 9 }),
      201,
    );
    expect(view.game.status).toBe("setup");
    expect(view.version).toBe(0);
    expect(view.teams.map((t) => t.name)).toEqual(["Team 1", "Team 2"]);
  });

  it("ignores an invalid JSON body", async () => {
    const res = await api.raw("POST", "/api/games", "{not json");
    expect((await readView(res, 201)).game.status).toBe("setup");
  });

  it("creates distinct games with distinct codes and team ids", async () => {
    const a = await readView(await api.post("/api/games"), 201);
    const b = await readView(await api.post("/api/games"), 201);
    expect(a.game.code).not.toBe(b.game.code);
    const ids = [...a.teams, ...b.teams].map((t) => t.id);
    expect(new Set(ids).size).toBe(4);
    expect(await gameCount()).toBe(2);
  });
});

describe("§4 game code generation", () => {
  it("builds the code from the injected random source", async () => {
    const rand = seqRandom([0, 1, 2, 3, 4]);
    const api2 = await player(makeDeps({ random: rand }).deps);
    const view = await readView(await api2.post("/api/games"), 201);
    expect(view.game.code).toBe("ABCDE");
    expect(rand.calls).toEqual([31, 31, 31, 31, 31]);
  });

  it("regenerates on a collision: AAAAA exists, so the second code BBBBB is used", async () => {
    await insertGame("AAAAA");
    const rand = seqRandom([0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
    const api2 = await player(makeDeps({ random: rand }).deps);
    const view = await readView(await api2.post("/api/games"), 201);
    expect(view.game.code).toBe("BBBBB");
    expect(rand.remaining()).toBe(0);
    expect(await gameCount()).toBe(2);
    // The existing game is untouched.
    expect((await gameRow("AAAAA")).version).toBe(0);
  });

  it("gives up after 5 colliding attempts with 500 internal and creates nothing", async () => {
    const taken = ["AAAAA", "BBBBB", "CCCCC", "DDDDD", "EEEEE"];
    for (const code of taken) await insertGame(code);
    // Five colliding codes, then a free one that must never be reached.
    const rand = seqRandom([0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5]);
    const api2 = await player(makeDeps({ random: rand }).deps);
    const res = await api2.post("/api/games");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal", message: "Something went wrong" });
    expect(rand.remaining()).toBe(5);
    expect(await gameCount()).toBe(5);
    const teams = await env.DB.prepare("SELECT COUNT(*) AS n FROM teams").first<{ n: number }>();
    expect(teams?.n).toBe(0);
  });
});
