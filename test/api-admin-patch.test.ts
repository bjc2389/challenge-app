// SPEC.md §9 /admin ("Each game can be marked or unmarked as a test"), §9 /history
// ("Test games are hidden entirely"), §3 cross-origin rule, §10 PATCH /api/admin/games/:code
// (sets isTest). Approved M6 plan:
// - body exactly `{isTest: boolean}`; anything else is 422 `validation`;
// - check order: malformed code 404, then body 422, then unknown code 404;
// - 200 with the updated AdminGame (equal to the list item); setting the same value
//   twice is allowed; games.version is not changed; a lowercase code works.
import { beforeEach, describe, expect, it } from "vitest";
import { expectError, expectValidationError, makeDeps } from "./helpers/auth";
import { T0, resetDb } from "./helpers/db";
import {
  ADMIN_GAME_KEYS,
  adminGameUrl,
  admin,
  adminItem,
  allGameRows,
  isTestFlag,
  listAdminGames,
  setTest,
  sortedKeys,
  type AdminApi,
} from "./helpers/admin";
import {
  anonymous,
  complete,
  expectApiError,
  gameRow,
  gameUrl,
  player,
  readView,
  seedRollCatalog,
  type Api,
} from "./helpers/game";
import {
  HOUR,
  MIN,
  finishedGame,
  getDetail,
  getList,
  historyUrl,
  namedGame,
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

describe("§3 §10 PATCH /api/admin/games/:code is admin-only", () => {
  it("anonymous gets 401 and nothing changes", async () => {
    const g = await namedGame(api, clock, { at: T0 });
    const res = await anonymous(clock.deps, "PATCH", adminGameUrl(g.code), { isTest: true });
    await expectError(res, 401, "unauthorized", "Log in to continue");
    expect(await isTestFlag(g.code)).toBe(0);
  });

  it("a player gets 403 and nothing changes", async () => {
    const g = await namedGame(api, clock, { at: T0 });
    await expectError(await api.patch(adminGameUrl(g.code), { isTest: true }), 403, "forbidden", "Admin access required");
    expect(await isTestFlag(g.code)).toBe(0);
  });
});

describe("§9 §10 PATCH /api/admin/games/:code sets isTest", () => {
  it("marks a game as a test: 200 with the updated AdminGame, equal to the list item", async () => {
    const g = await finishedGame(api, clock, { at: T0, finalMin: 20 });
    const before = await adminItem(adm, g.code);
    expect(before.isTest).toBe(false);

    const body = await setTest(adm, g.code, true);
    expect(sortedKeys(body)).toEqual(ADMIN_GAME_KEYS);
    expect(body).toEqual({ ...before, isTest: true });
    expect(await adminItem(adm, g.code)).toEqual(body);
    expect(await isTestFlag(g.code)).toBe(1);
  });

  it("unmarks a test game", async () => {
    const g = await finishedGame(api, clock, { at: T0, finalMin: 20 });
    const before = await adminItem(adm, g.code);
    await setTest(adm, g.code, true);
    const body = await setTest(adm, g.code, false);
    expect(body).toEqual(before);
    expect(await adminItem(adm, g.code)).toEqual(body);
    expect(await isTestFlag(g.code)).toBe(0);
  });

  it("setting the same value twice is allowed (true, true, then false, false)", async () => {
    const g = await namedGame(api, clock, { at: T0 });
    const t1 = await setTest(adm, g.code, true);
    const t2 = await setTest(adm, g.code, true);
    expect(t2).toEqual(t1);
    expect(await isTestFlag(g.code)).toBe(1);
    const f1 = await setTest(adm, g.code, false);
    const f2 = await setTest(adm, g.code, false);
    expect(f2).toEqual(f1);
    expect(f2.isTest).toBe(false);
    expect(await isTestFlag(g.code)).toBe(0);
  });

  it("setting false on a game that was never a test is allowed", async () => {
    const g = await namedGame(api, clock, { at: T0 });
    expect((await setTest(adm, g.code, false)).isTest).toBe(false);
  });

  it("does not change games.version, nor any other column", async () => {
    const g = await startedGame(api, clock, { at: T0 });
    const before = await gameRow(g.code);
    await setTest(adm, g.code, true);
    expect(await gameRow(g.code)).toEqual({ ...before, is_test: 1 });
    await setTest(adm, g.code, false);
    expect(await gameRow(g.code)).toEqual(before);
  });

  it("changes only the target game", async () => {
    const a = await namedGame(api, clock, { at: T0 });
    const b = await namedGame(api, clock, { at: T0 + MIN });
    const before = await allGameRows();
    await setTest(adm, a.code, true);
    const after = await allGameRows();
    expect(after.find((r) => r.code === b.code)).toEqual(before.find((r) => r.code === b.code));
    expect(after.find((r) => r.code === a.code)).toEqual({ ...before.find((r) => r.code === a.code), is_test: 1 });
  });

  it("accepts a lowercase code; the response carries the canonical uppercase code", async () => {
    const g = await namedGame(api, clock, { at: T0 });
    const body = await setTest(adm, g.code.toLowerCase(), true);
    expect(body.code).toBe(g.code);
    expect(body.isTest).toBe(true);
    expect(await isTestFlag(g.code)).toBe(1);
  });

  it.each(["setup", "rolled", "active", "finished", "abandoned"] as const)("works on a %s game", async (status) => {
    const g = await namedGame(api, clock, { at: T0 });
    if (status !== "setup" && status !== "abandoned") {
      await readView(await api.post(gameUrl(g.code, "/roll")));
    }
    if (status === "active" || status === "finished") await readView(await api.post(gameUrl(g.code, "/start")));
    if (status === "abandoned") await readView(await api.post(gameUrl(g.code, "/abandon")));
    if (status === "finished") {
      // Finish by timeout: a GET at ends_at finalizes it.
      clock.setNow((await gameRow(g.code)).ends_at ?? 0);
      await readView(await api.get(gameUrl(g.code)));
    }
    expect((await gameRow(g.code)).status).toBe(status);
    const body = await setTest(adm, g.code, true);
    expect(body).toMatchObject({ code: g.code, status, isTest: true });
  });
});

describe("§10 PATCH /api/admin/games/:code not found", () => {
  it("an unknown (well-formed) code gets 404 not_found", async () => {
    await expectApiError(await adm.patch(adminGameUrl("ZZZZZ"), { isTest: true }), 404, "not_found");
  });

  it.each(["ABCD", "ABCDEF", "ABCD1", "ABCDO", "AB-DE", "%20%20%20%20%20"])(
    "a malformed code %s gets 404 not_found",
    async (code) => {
      await expectApiError(await adm.patch(adminGameUrl(code), { isTest: true }), 404, "not_found");
    },
  );

  it("a malformed code is checked before the body: 404, not 422", async () => {
    await expectApiError(await adm.patch(adminGameUrl("ABCD1"), { isTest: "yes" }), 404, "not_found");
    await expectApiError(await adm.raw("PATCH", adminGameUrl("ABCD1"), undefined), 404, "not_found");
  });

  it("the body is checked before the game exists: an unknown code with a bad body gets 422", async () => {
    await expectValidationError(await adm.patch(adminGameUrl("ZZZZZ"), { isTest: "yes" }));
    await expectValidationError(await adm.raw("PATCH", adminGameUrl("ZZZZZ"), undefined));
  });

  it("a deleted game gets 404", async () => {
    const g = await namedGame(api, clock, { at: T0 });
    expect((await adm.delete(adminGameUrl(g.code))).status).toBe(200);
    await expectApiError(await adm.patch(adminGameUrl(g.code), { isTest: true }), 404, "not_found");
  });
});

describe("§10 PATCH /api/admin/games/:code validation (422)", () => {
  const jsonBodies: Array<[string, unknown]> = [
    ["an empty object", {}],
    ["isTest as the string \"true\"", { isTest: "true" }],
    ["isTest as 1", { isTest: 1 }],
    ["isTest as 0", { isTest: 0 }],
    ["isTest as null", { isTest: null }],
    ["isTest as an object", { isTest: {} }],
    ["an extra key", { isTest: true, extra: 1 }],
    ["only a different key", { is_test: true }],
    ["a misspelled key", { istest: true }],
    ["an array", [true]],
    ["an array holding the object", [{ isTest: true }]],
    ["an empty array", []],
    ["a bare boolean", true],
    ["a bare string", "true"],
    ["a bare number", 1],
    ["null", null],
  ];

  it.each(jsonBodies)("%s gets 422 and changes nothing", async (_name, body) => {
    const g = await namedGame(api, clock, { at: T0 });
    const before = await gameRow(g.code);
    await expectValidationError(await adm.patch(adminGameUrl(g.code), body));
    expect(await gameRow(g.code)).toEqual(before);
  });

  it.each([
    ["non-JSON text", "{isTest: true"],
    ["an empty string", ""],
    ["plain words", "isTest=true"],
  ])("%s gets 422 and changes nothing", async (_name, raw) => {
    const g = await namedGame(api, clock, { at: T0 });
    const before = await gameRow(g.code);
    await expectValidationError(await adm.raw("PATCH", adminGameUrl(g.code), raw));
    expect(await gameRow(g.code)).toEqual(before);
  });

  it("no body at all gets 422 and changes nothing", async () => {
    const g = await namedGame(api, clock, { at: T0 });
    const before = await gameRow(g.code);
    await expectValidationError(await adm.raw("PATCH", adminGameUrl(g.code), undefined));
    expect(await gameRow(g.code)).toEqual(before);
  });
});

describe("§9 a test game is hidden from history; unmarking restores it", () => {
  it("marking hides it from items, gamesPlayed and records, and the detail is 404", async () => {
    const g = await finishedGame(api, clock, { at: T0, finalMin: 20 });
    const listBefore = await getList(api);
    expect(listBefore.items.map((i) => i.code)).toEqual([g.code]);
    expect(listBefore.records.gamesPlayed).toBe(1);
    expect(listBefore.records.fastestWin?.code).toBe(g.code);
    expect(listBefore.records.fastestPuzzle?.code).toBe(g.code);
    const detailBefore = await getDetail(api, g.code);

    await setTest(adm, g.code, true);
    const hidden = await getList(api);
    expect(hidden.items).toEqual([]);
    expect(hidden.hasMore).toBe(false);
    expect(hidden.records).toEqual({ fastestWin: null, fastestPuzzle: null, gamesPlayed: 0 });
    await expectApiError(await api.get(historyUrl(g.code)), 404, "not_found");

    await setTest(adm, g.code, false);
    expect(await getList(api)).toEqual(listBefore);
    expect(await getDetail(api, g.code)).toEqual(detailBefore);
  });

  it("a test timeout game no longer counts toward gamesPlayed, while other games still do", async () => {
    const win = await finishedGame(api, clock, { at: T0, finalMin: 20 });
    const tie = await timedOutGame(api, clock, { at: T0 + 2 * HOUR });
    expect((await getList(api)).records.gamesPlayed).toBe(2);
    await setTest(adm, tie.code, true);
    const list = await getList(api);
    expect(list.items.map((i) => i.code)).toEqual([win.code]);
    expect(list.records.gamesPlayed).toBe(1);
  });
});

describe("§9 the game API still works for a test game", () => {
  it("GET and complete succeed, and version still goes up by 1 on a change", async () => {
    const g = await startedGame(api, clock, { at: T0 });
    await setTest(adm, g.code, true);
    const view = await readView(await api.get(gameUrl(g.code)));
    expect(view.game.status).toBe("active");
    clock.advance(MIN);
    const after = await readView(await complete(api, g.code, g.taskIds[0] as number, g.teamIds[0]));
    expect(after.version).toBe(view.version + 1);
    expect(after.teams[0]?.score).toBe(1);
    expect((await listAdminGames(adm)).items[0]).toMatchObject({ code: g.code, isTest: true, status: "active" });
  });
});

describe("§3 cross-origin PATCH /api/admin/games/:code gets 403", () => {
  it.each([
    ["an Origin from another site", { origin: "https://evil.example" }],
    ["Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }],
  ])("%s: 403 and nothing changes", async (_name, headers) => {
    const g = await namedGame(api, clock, { at: T0 });
    const before = await gameRow(g.code);
    const res = await adm.patch(adminGameUrl(g.code), { isTest: true }, headers);
    await expectError(res, 403, "forbidden", "Cross-origin request blocked");
    expect(await gameRow(g.code)).toEqual(before);
  });
});
