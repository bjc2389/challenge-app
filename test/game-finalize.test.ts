// SPEC.md §4 Timeout: the first request at or after ends_at finalizes. Most completions wins;
// if tied, the earlier last completion wins; if still tied, no winner.
import { describe, expect, it } from "vitest";
import { isExpired, timeoutWinner } from "../src/worker/game/finalize";
import type { GameStatus } from "../src/worker/game/types";

const ENDS = 1_000_000;

describe("§4 isExpired", () => {
  it("is false at ends_at - 1", () => {
    expect(isExpired({ status: "active", endsAt: ENDS }, ENDS - 1)).toBe(false);
  });

  it("is true at exactly ends_at", () => {
    expect(isExpired({ status: "active", endsAt: ENDS }, ENDS)).toBe(true);
  });

  it("is true after ends_at", () => {
    expect(isExpired({ status: "active", endsAt: ENDS }, ENDS + 1)).toBe(true);
    expect(isExpired({ status: "active", endsAt: ENDS }, ENDS + 86_400_000)).toBe(true);
  });

  it.each<GameStatus>(["setup", "rolled", "finished", "abandoned"])("is false for a %s game past ends_at", (status) => {
    expect(isExpired({ status, endsAt: ENDS }, ENDS + 1)).toBe(false);
  });

  it("is false for an active game with no ends_at", () => {
    expect(isExpired({ status: "active", endsAt: null }, ENDS)).toBe(false);
  });
});

describe("§4 timeoutWinner: most completions wins", () => {
  it("team 1 with more completions wins, even with a later last completion", () => {
    expect(
      timeoutWinner([
        { teamId: 1, completedAts: [100, 900] },
        { teamId: 2, completedAts: [50] },
      ]),
    ).toBe(1);
  });

  it("team 2 with more completions wins, regardless of list order", () => {
    expect(
      timeoutWinner([
        { teamId: 1, completedAts: [10] },
        { teamId: 2, completedAts: [500, 600, 700] },
      ]),
    ).toBe(2);
    expect(
      timeoutWinner([
        { teamId: 2, completedAts: [500, 600, 700] },
        { teamId: 1, completedAts: [10] },
      ]),
    ).toBe(2);
  });

  it("1–0 wins", () => {
    expect(timeoutWinner([{ teamId: 7, completedAts: [] }, { teamId: 8, completedAts: [123] }])).toBe(8);
  });
});

describe("§4 timeoutWinner: equal counts, earlier last completion wins", () => {
  it("team 1 wins when its last completion is earlier", () => {
    expect(
      timeoutWinner([
        { teamId: 1, completedAts: [100, 200] },
        { teamId: 2, completedAts: [50, 201] },
      ]),
    ).toBe(1);
  });

  it("team 2 wins when its last completion is earlier", () => {
    expect(
      timeoutWinner([
        { teamId: 1, completedAts: [10, 300] },
        { teamId: 2, completedAts: [250, 299] },
      ]),
    ).toBe(2);
  });

  it("compares the maximum, not the first value or the array order", () => {
    // Team 1's last completion is 400 (listed first); team 2's is 350.
    expect(
      timeoutWinner([
        { teamId: 1, completedAts: [400, 5] },
        { teamId: 2, completedAts: [350, 340] },
      ]),
    ).toBe(2);
  });

  it("a 1 ms difference decides it", () => {
    expect(timeoutWinner([{ teamId: 1, completedAts: [1001] }, { teamId: 2, completedAts: [1000] }])).toBe(2);
  });
});

describe("§4 timeoutWinner: true ties", () => {
  it("equal counts and equal last completion is a tie (null)", () => {
    expect(
      timeoutWinner([
        { teamId: 1, completedAts: [100, 500] },
        { teamId: 2, completedAts: [300, 500] },
      ]),
    ).toBeNull();
  });

  it("0–0 is a tie (null)", () => {
    expect(timeoutWinner([{ teamId: 1, completedAts: [] }, { teamId: 2, completedAts: [] }])).toBeNull();
  });
});
