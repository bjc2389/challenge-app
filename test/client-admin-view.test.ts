// SPEC.md §9 /admin: "A games table showing code, date, status, teams, result and test
// flag. Each game can be marked or unmarked as a test, or deleted (with confirmation;
// this is a permanent delete). A read-only view of the catalog." §10 error codes.
// Pure client helpers from the approved M6 plan (src/client/admin/view.ts); no DOM.
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/client/apiError";
import type { AdminCategory, AdminGame } from "../src/client/admin/types";
import {
  adminErrorMessage,
  catalogSummary,
  deleteConfirm,
  gameRow,
  removeGame,
  replaceGame,
  testToggleLabel,
} from "../src/client/admin/view";
import { errorMessage } from "../src/client/game/errors";

const MIN = 60_000;
const C = Date.UTC(2026, 9, 20, 12, 0, 0);

function game(over: Partial<AdminGame> = {}): AdminGame {
  return {
    code: "ABCDE",
    status: "finished",
    isTest: false,
    createdAt: C,
    startedAt: C + 2 * MIN,
    endedAt: C + 32 * MIN,
    endReason: "completed",
    winnerTeamId: 11,
    elapsedMs: 30 * MIN,
    teams: [
      { id: 11, slot: 1, name: "Reds", score: 4 },
      { id: 12, slot: 2, name: "Blues", score: 3 },
    ],
    ...over,
  };
}

const IN_PROGRESS = { winnerTeamId: null, endReason: null, endedAt: null, elapsedMs: null } as const;

function category(over: Partial<AdminCategory> = {}): AdminCategory {
  return {
    id: "drinks",
    name: "Drinks",
    order: 1,
    countPerGame: 2,
    final: false,
    active: true,
    tasks: [{ id: "drinks-a", text: "Drink A", active: true }],
    ...over,
  };
}

/** Recursively freezes a value, so any mutation throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe("§9 gameRow", () => {
  it("returns exactly code, date, statusLabel, teams, result and isTest", () => {
    const row = gameRow(game(), "UTC");
    expect(Object.keys(row).sort()).toEqual(["code", "date", "isTest", "result", "statusLabel", "teams"]);
    expect(row.code).toBe("ABCDE");
    expect(row.isTest).toBe(false);
    expect(gameRow(game({ isTest: true }), "UTC").isTest).toBe(true);
  });

  it("teams read like 'Reds 4 – 3 Blues' with an en dash", () => {
    expect(gameRow(game(), "UTC").teams).toBe("Reds 4 – 3 Blues");
  });

  it("teams are in slot order even when the array isn't", () => {
    const g = game({
      teams: [
        { id: 12, slot: 2, name: "Blues", score: 3 },
        { id: 11, slot: 1, name: "Reds", score: 4 },
      ],
    });
    expect(gameRow(g, "UTC").teams).toBe("Reds 4 – 3 Blues");
  });

  it.each([
    ["setup", "Setup"],
    ["rolled", "Rolled"],
    ["active", "Active"],
    ["finished", "Finished"],
    ["abandoned", "Abandoned"],
  ] as const)("statusLabel for %s is %s", (status, label) => {
    expect(gameRow(game({ status }), "UTC").statusLabel).toBe(label);
  });

  it.each(["setup", "rolled", "active"] as const)("result for %s is 'In progress'", (status) => {
    expect(gameRow(game({ status, ...IN_PROGRESS }), "UTC").result).toBe("In progress");
  });

  it("result for an abandoned game is 'Abandoned'", () => {
    expect(gameRow(game({ status: "abandoned", winnerTeamId: null, endReason: null }), "UTC").result).toBe("Abandoned");
  });

  it("result for a completion win names the winner: 'Reds won'", () => {
    expect(gameRow(game(), "UTC").result).toBe("Reds won");
  });

  it("result for a slot 2 timeout win: 'Blues won'", () => {
    expect(gameRow(game({ winnerTeamId: 12, endReason: "timeout" }), "UTC").result).toBe("Blues won");
  });

  it("result for a finished game with no winner is 'Tie'", () => {
    expect(gameRow(game({ winnerTeamId: null, endReason: "timeout" }), "UTC").result).toBe("Tie");
  });

  it("date is the formatted createdAt and contains the year", () => {
    const row = gameRow(game(), "UTC");
    expect(typeof row.date).toBe("string");
    expect(row.date).toContain("2026");
  });

  it("date uses the given time zone (the same instant is a different year east of UTC)", () => {
    const g = game({ createdAt: Date.UTC(2026, 11, 31, 23, 30, 0) });
    expect(gameRow(g, "UTC").date).toContain("2026");
    expect(gameRow(g, "UTC").date).not.toContain("2027");
    expect(gameRow(g, "Pacific/Kiritimati").date).toContain("2027");
  });

  it("date depends on createdAt, not startedAt or endedAt", () => {
    const g = game({ createdAt: Date.UTC(2025, 5, 1, 12, 0, 0) });
    expect(gameRow(g, "UTC").date).toContain("2025");
    expect(gameRow(g, "UTC").date).not.toContain("2026");
  });

  it("does not mutate its input", () => {
    const g = game();
    const copy = structuredClone(g);
    gameRow(deepFreeze(g), "UTC");
    expect(g).toEqual(copy);
  });
});

describe("§9 deleteConfirm (permanent delete, with confirmation)", () => {
  it("the title contains the code; the body says it can't be undone", () => {
    const { title, body } = deleteConfirm(game({ code: "XYZ23" }));
    expect(title).toContain("XYZ23");
    expect(body).toContain("can't be undone");
  });

  it("returns exactly title and body", () => {
    expect(Object.keys(deleteConfirm(game())).sort()).toEqual(["body", "title"]);
  });

  it.each(["setup", "rolled", "active"] as const)("a %s game's body also warns it is in progress", (status) => {
    const { body } = deleteConfirm(game({ status, ...IN_PROGRESS }));
    expect(body).toContain("in progress");
    expect(body).toContain("can't be undone");
  });

  it.each(["finished", "abandoned"] as const)("a %s game's body does not say in progress", (status) => {
    const { body } = deleteConfirm(game({ status }));
    expect(body).not.toContain("in progress");
    expect(body).toContain("can't be undone");
  });
});

describe("§9 testToggleLabel", () => {
  it("'Mark as test' for a normal game, 'Unmark test' for a test game", () => {
    expect(testToggleLabel(game({ isTest: false }))).toBe("Mark as test");
    expect(testToggleLabel(game({ isTest: true }))).toBe("Unmark test");
  });
});

describe("§9 replaceGame and removeGame are pure", () => {
  const list = (): AdminGame[] => [game({ code: "AAAAA" }), game({ code: "BBBBB" }), game({ code: "CCCCC" })];

  it("replaceGame swaps in the game with the same code, keeping its position", () => {
    const updated = game({ code: "BBBBB", isTest: true });
    const out = replaceGame(list(), updated);
    expect(out.map((g: AdminGame) => g.code)).toEqual(["AAAAA", "BBBBB", "CCCCC"]);
    expect(out[1]).toEqual(updated);
    expect(out[0]).toEqual(list()[0]);
    expect(out[2]).toEqual(list()[2]);
  });

  it("replaceGame does not mutate the list or the game", () => {
    const input = deepFreeze(list());
    const updated = deepFreeze(game({ code: "BBBBB", isTest: true }));
    const out = replaceGame(input, updated);
    expect(out).not.toBe(input);
    expect(input).toEqual(list());
  });

  it("removeGame drops the game with that code and keeps the rest in order", () => {
    expect(removeGame(list(), "BBBBB").map((g: AdminGame) => g.code)).toEqual(["AAAAA", "CCCCC"]);
  });

  it("removeGame does not mutate the list", () => {
    const input = deepFreeze(list());
    const out = removeGame(input, "AAAAA");
    expect(out).not.toBe(input);
    expect(input).toEqual(list());
    expect(out.map((g: AdminGame) => g.code)).toEqual(["BBBBB", "CCCCC"]);
  });
});

describe("§7 §9 catalogSummary", () => {
  it("'2 per game' for an active, non-final category", () => {
    expect(catalogSummary(category({ countPerGame: 2 }))).toBe("2 per game");
  });

  it("'1 per game · final' for the active final category", () => {
    expect(catalogSummary(category({ countPerGame: 1, final: true }))).toBe("1 per game · final");
  });

  it("'1 per game · inactive' for an inactive category", () => {
    expect(catalogSummary(category({ countPerGame: 1, active: false }))).toBe("1 per game · inactive");
  });

  it("an inactive final category names both, joined with ' · ' after the count", () => {
    const parts = catalogSummary(category({ countPerGame: 1, final: true, active: false })).split(" · ");
    expect(parts[0]).toBe("1 per game");
    expect([...parts].sort()).toEqual(["1 per game", "final", "inactive"]);
  });

  it("does not mutate its input", () => {
    const c = category();
    catalogSummary(deepFreeze(c));
    expect(c).toEqual(category());
  });
});

describe("§3 §10 adminErrorMessage", () => {
  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
  ])("%i %s: 'Log in as admin'", (status, code) => {
    expect(adminErrorMessage(new ApiError(status, code, "server text"))).toBe("Log in as admin");
  });

  it("404: 'That game no longer exists'", () => {
    expect(adminErrorMessage(new ApiError(404, "not_found", "Not found"))).toBe("That game no longer exists");
  });

  it.each([
    ["busy (409)", new ApiError(409, "busy", "server text")],
    ["validation (422)", new ApiError(422, "validation", "isTest must be true or false")],
    ["internal (500)", new ApiError(500, "internal", "Something went wrong")],
    ["a network failure", new TypeError("Failed to fetch")],
    ["something unknown", new Error("boom")],
  ])("%s falls back to errorMessage", (_name, err) => {
    expect(adminErrorMessage(err)).toBe(errorMessage(err));
  });
});
