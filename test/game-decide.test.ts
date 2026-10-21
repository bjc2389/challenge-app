// SPEC.md §4, §5: the pure decisions for rename, roll, start and abandon.
import { describe, expect, it } from "vitest";
import { GAME_DURATION_MS } from "../src/worker/game/constants";
import { decideAbandon, decideRename, decideRoll, decideStart } from "../src/worker/game/state";
import type { CatalogCategory, CatalogTask, GameStatus } from "../src/worker/game/types";
import { ENDS_AT, makeSnapshot } from "./helpers/snapshot";
import { seqRandom } from "./helpers/game";

const NOW = ENDS_AT - 10 * 60_000;
const STATUSES: GameStatus[] = ["setup", "rolled", "active", "finished", "abandoned"];
const errorCode = (status: GameStatus) => (status === "finished" || status === "abandoned" ? "game_over" : "invalid_state");

const CATEGORIES: CatalogCategory[] = [
  { id: "drinks", name: "Drinks", sortOrder: 1, countPerGame: 1, isFinal: false, active: true },
  { id: "puzzle", name: "Final Puzzle", sortOrder: 2, countPerGame: 1, isFinal: true, active: true },
];
const TASKS: CatalogTask[] = [
  { id: "drinks-a", categoryId: "drinks", text: "Drink A", active: true },
  { id: "puzzle-a", categoryId: "puzzle", text: "Puzzle A", active: true },
];

describe("§4 decideRename", () => {
  it.each(["setup", "rolled"] as const)("renames in %s", (status) => {
    expect(decideRename(makeSnapshot({ status }), { team1: " Reds ", team2: "Blues" })).toEqual({
      kind: "change",
      change: { kind: "rename", names: ["Reds", "Blues"] },
    });
  });

  it("is a noop for the current names", () => {
    expect(decideRename(makeSnapshot({ status: "setup" }), { team1: "Team 1", team2: " Team 2 " })).toEqual({ kind: "noop" });
  });

  it.each([undefined, null, [], "x", { team1: "A" }, { team1: "Same", team2: "same" }])("rejects body %j with 422", (body) => {
    expect(decideRename(makeSnapshot({ status: "setup" }), body)).toMatchObject({ kind: "error", status: 422, error: "validation" });
  });

  it.each(["active", "finished", "abandoned"] as const)("gives 409 in %s, before looking at the body", (status) => {
    expect(decideRename(makeSnapshot({ status }), undefined)).toMatchObject({ status: 409, error: errorCode(status) });
  });
});

describe("§5 decideRoll", () => {
  it("rolls from setup with the injected random source", () => {
    const decision = decideRoll(makeSnapshot({ status: "setup" }), { categories: CATEGORIES, tasks: TASKS }, seqRandom([0, 0]), NOW);
    expect(decision).toEqual({
      kind: "change",
      change: {
        kind: "roll",
        at: NOW,
        tasks: [
          { catalogTaskId: "drinks-a", categoryId: "drinks", text: "Drink A", sortOrder: 1, isFinal: false },
          { catalogTaskId: "puzzle-a", categoryId: "puzzle", text: "Puzzle A", sortOrder: 2, isFinal: true },
        ],
      },
    });
  });

  it("gives 409 catalog_incomplete naming a short category", () => {
    const decision = decideRoll(makeSnapshot({ status: "setup" }), { categories: CATEGORIES, tasks: TASKS.slice(1) }, seqRandom([]), NOW);
    expect(decision).toMatchObject({ kind: "error", status: 409, error: "catalog_incomplete" });
    expect(decision.kind === "error" && decision.message).toContain("Drinks");
  });

  it.each(STATUSES.filter((s) => s !== "setup"))("gives 409 in %s without rolling", (status) => {
    const rand = seqRandom([]);
    expect(decideRoll(makeSnapshot({ status }), { categories: CATEGORIES, tasks: TASKS }, rand, NOW)).toMatchObject({
      status: 409,
      error: errorCode(status),
    });
  });
});

describe("§4 decideStart", () => {
  it("starts from rolled with a 60-minute deadline", () => {
    expect(decideStart(makeSnapshot({ status: "rolled" }), NOW)).toEqual({
      kind: "change",
      change: { kind: "start", at: NOW, endsAt: NOW + GAME_DURATION_MS },
    });
  });

  it.each(STATUSES.filter((s) => s !== "rolled"))("gives 409 in %s", (status) => {
    expect(decideStart(makeSnapshot({ status }), NOW)).toMatchObject({ status: 409, error: errorCode(status) });
  });
});

describe("§4 decideAbandon", () => {
  it.each(["setup", "rolled", "active"] as const)("abandons from %s", (status) => {
    expect(decideAbandon(makeSnapshot({ status }), NOW)).toEqual({ kind: "change", change: { kind: "abandon", at: NOW } });
  });

  it("abandons an active game one ms before ends_at", () => {
    expect(decideAbandon(makeSnapshot(), ENDS_AT - 1)).toMatchObject({ kind: "change" });
  });

  it.each([0, 1])("gives 409 game_over for an active game at ends_at + %i", (extra) => {
    expect(decideAbandon(makeSnapshot(), ENDS_AT + extra)).toMatchObject({ status: 409, error: "game_over" });
  });

  it.each(["finished", "abandoned"] as const)("gives 409 game_over in %s", (status) => {
    expect(decideAbandon(makeSnapshot({ status }), NOW)).toMatchObject({ status: 409, error: "game_over" });
  });
});
