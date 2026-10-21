// SPEC.md §4 Setup/Rolled: team names are 1–24 characters after trimming and must differ
// (ignoring case); editable in setup and rolled. §6 version, §10 PATCH /api/games/:code/teams.
import { beforeEach, describe, expect, it } from "vitest";
import { makeDeps } from "./helpers/auth";
import { resetDb } from "./helpers/db";
import {
  activeGame,
  anonymous,
  createGame,
  expectApiError,
  gameIn,
  gameRow,
  gameState,
  gameUrl,
  player,
  readView,
  rollGame,
  seedRollCatalog,
  teamRows,
  type Api,
} from "./helpers/game";

let ctx: ReturnType<typeof makeDeps>;
let api: Api;

beforeEach(async () => {
  await resetDb();
  await seedRollCatalog();
  ctx = makeDeps();
  api = await player(ctx.deps);
});

const rename = (code: string, body: unknown) => api.patch(gameUrl(code, "/teams"), body);

describe("§3 §10 PATCH /api/games/:code/teams auth and lookup", () => {
  it("401 without a session, and nothing changes", async () => {
    const { game } = await createGame(api);
    const res = await anonymous(ctx.deps, "PATCH", gameUrl(game.code, "/teams"), { team1: "Red", team2: "Blue" });
    await expectApiError(res, 401, "unauthorized");
    expect((await gameRow(game.code)).version).toBe(0);
  });

  it.each(["ZZZZZ", "ABCD", "ABCD0"])("404 for unknown or malformed code %s", async (code) => {
    await expectApiError(await rename(code, { team1: "Red", team2: "Blue" }), 404, "not_found");
  });
});

describe("§4 rename in setup and rolled", () => {
  it("setup: saves trimmed names and bumps the version once", async () => {
    const { game } = await createGame(api);
    const view = await readView(await rename(game.code, { team1: "  Red Team ", team2: "\tBlue\t" }));
    expect(view.teams.map((t) => [t.slot, t.name])).toEqual([
      [1, "Red Team"],
      [2, "Blue"],
    ]);
    expect(view.version).toBe(1);
    expect(view.game.status).toBe("setup");
    const row = await gameRow(game.code);
    expect(row.version).toBe(1);
    expect((await teamRows(row.id)).map((t) => t.name)).toEqual(["Red Team", "Blue"]);
  });

  it("rolled: renames and bumps the version once; tasks are untouched", async () => {
    const { game } = await createGame(api);
    const rolled = await rollGame(api, game.code);
    const view = await readView(await rename(game.code, { team1: "Red", team2: "Blue" }));
    expect(view.version).toBe(rolled.version + 1);
    expect(view.game.status).toBe("rolled");
    expect(view.teams.map((t) => t.name)).toEqual(["Red", "Blue"]);
    expect(view.tasks).toEqual(rolled.tasks);
    // Team ids are stable across a rename.
    expect(view.teams.map((t) => t.id)).toEqual(rolled.teams.map((t) => t.id));
  });

  it("accepts 24-character and 24-emoji names", async () => {
    const { game } = await createGame(api);
    const a = "a".repeat(24);
    const b = "\u{1F37A}".repeat(24);
    const view = await readView(await rename(game.code, { team1: a, team2: b }));
    expect(view.teams.map((t) => t.name)).toEqual([a, b]);
  });

  it("renaming again bumps again; the same names are a noop with no bump", async () => {
    const { game } = await createGame(api);
    await readView(await rename(game.code, { team1: "Red", team2: "Blue" }));
    const same = await readView(await rename(game.code, { team1: "Red", team2: "Blue" }));
    expect(same.version).toBe(1);
    const sameAfterTrim = await readView(await rename(game.code, { team1: " Red ", team2: "Blue  " }));
    expect(sameAfterTrim.version).toBe(1);
    expect((await gameRow(game.code)).version).toBe(1);
    const changed = await readView(await rename(game.code, { team1: "Red", team2: "Green" }));
    expect(changed.version).toBe(2);
  });

  it("the default names unchanged are a noop", async () => {
    const { game } = await createGame(api);
    const view = await readView(await rename(game.code, { team1: "Team 1", team2: "Team 2" }));
    expect(view.version).toBe(0);
  });

  it("a case-only change is a real change", async () => {
    const { game } = await createGame(api);
    const view = await readView(await rename(game.code, { team1: "team 1", team2: "Team 2" }));
    expect(view.version).toBe(1);
    expect(view.teams[0]?.name).toBe("team 1");
  });

  it("swapping the two names is a real change", async () => {
    const { game } = await createGame(api);
    const view = await readView(await rename(game.code, { team1: "Team 2", team2: "Team 1" }));
    expect(view.version).toBe(1);
    expect(view.teams.map((t) => [t.slot, t.name])).toEqual([
      [1, "Team 2"],
      [2, "Team 1"],
    ]);
  });
});

describe("§4 §10 rename validation (422)", () => {
  it.each<[string, unknown]>([
    ["missing team1", { team2: "Blue" }],
    ["missing team2", { team1: "Red" }],
    ["empty body object", {}],
    ["empty name", { team1: "", team2: "Blue" }],
    ["blank name", { team1: "Red", team2: "   " }],
    ["25 characters", { team1: "a".repeat(25), team2: "Blue" }],
    ["control character", { team1: "Red\nTeam", team2: "Blue" }],
    ["DEL", { team1: "Red\u007f", team2: "Blue" }],
    ["same name", { team1: "Red", team2: "Red" }],
    ["same ignoring case", { team1: "Red", team2: " rED " }],
    ["number", { team1: 1, team2: "Blue" }],
    ["null", { team1: "Red", team2: null }],
    ["array body", ["Red", "Blue"]],
    ["string body", "Red"],
    ["null body", null],
  ])("%s", async (_name, body) => {
    const { game } = await createGame(api);
    const before = await gameState((await gameRow(game.code)).id);
    await expectApiError(await rename(game.code, body), 422, "validation");
    expect(await gameState((await gameRow(game.code)).id)).toEqual(before);
  });

  it("invalid JSON", async () => {
    const { game } = await createGame(api);
    await expectApiError(await api.raw("PATCH", gameUrl(game.code, "/teams"), "{team1:"), 422, "validation");
    expect((await gameRow(game.code)).version).toBe(0);
  });

  it("no body", async () => {
    const { game } = await createGame(api);
    await expectApiError(await api.request("PATCH", gameUrl(game.code, "/teams")), 422, "validation");
  });
});

describe("§4 rename is not allowed once started (409)", () => {
  it.each([
    ["active", "invalid_state"],
    ["finished", "game_over"],
    ["abandoned", "game_over"],
  ] as const)("%s gives 409 %s with no writes", async (status, error) => {
    const { code, gameId } = await gameIn(api, status);
    const before = await gameState(gameId);
    await expectApiError(await rename(code, { team1: "Red", team2: "Blue" }), 409, error);
    expect(await gameState(gameId)).toEqual(before);
  });

  it("an expired active game is finalized first (version +1), then 409 game_over", async () => {
    const g = await activeGame(api);
    const v0 = (await gameRow(g.code)).version;
    ctx.setNow(g.endsAt);
    await expectApiError(await rename(g.code, { team1: "Red", team2: "Blue" }), 409, "game_over");
    const row = await gameRow(g.code);
    expect(row).toMatchObject({ status: "finished", end_reason: "timeout", ended_at: g.endsAt, version: v0 + 1 });
    expect((await teamRows(row.id)).map((t) => t.name)).toEqual(["Team 1", "Team 2"]);
  });
});
