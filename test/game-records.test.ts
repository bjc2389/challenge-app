// SPEC.md §9 records (fastest win, fastest puzzle, games played; abandoned and test games
// excluded) and §9 /history/:code split times, as pure functions over already-loaded games.
// Approved M5 decisions: fastest win counts only end_reason "completed"; fastest puzzle is
// finalAt − (lastNonFinalAt ?? startedAt) from the final team_tasks state; games played
// counts finished, non-test games (timeouts and ties included); record ties go to the
// earlier endedAt, then the lower code.
import { describe, expect, it } from "vitest";
import {
  computeRecords,
  elapsedMs,
  fastestPuzzle,
  fastestWin,
  gamesPlayed,
  puzzleMs,
  recordEligible,
  splitMs,
  type HistoryGame,
  type HistoryTeam,
} from "../src/worker/game/records";
import { T0 } from "./helpers/db";

const MIN = 60_000;

let nextTeamId = 1;

function team(slot: 1 | 2, over: Partial<HistoryTeam> = {}): HistoryTeam {
  return {
    id: nextTeamId++,
    slot,
    name: slot === 1 ? "Reds" : "Blues",
    score: 0,
    lastNonFinalAt: null,
    finalAt: null,
    ...over,
  };
}

/**
 * A finished completion win by slot 1 lasting `mins` minutes, starting at T0 + `startMin`.
 * The winner's puzzle time is 5 minutes unless teams are overridden.
 */
function win(code: string, mins: number, opts: { startMin?: number; winnerSlot?: 1 | 2; names?: [string, string] } = {}): HistoryGame {
  const startedAt = T0 + (opts.startMin ?? 0) * MIN;
  const endedAt = startedAt + mins * MIN;
  const winnerSlot = opts.winnerSlot ?? 1;
  const teams = [1, 2].map((slot) =>
    team(slot as 1 | 2, {
      name: opts.names?.[slot - 1] ?? (slot === 1 ? "Reds" : "Blues"),
      ...(slot === winnerSlot ? { score: 4, lastNonFinalAt: endedAt - 5 * MIN, finalAt: endedAt } : { score: 2, lastNonFinalAt: startedAt + MIN }),
    }),
  );
  return {
    code,
    status: "finished",
    isTest: false,
    startedAt,
    endedAt,
    endReason: "completed",
    winnerTeamId: teams[winnerSlot - 1]!.id,
    teams,
  };
}

function timeout(code: string, opts: { startMin?: number; winnerSlot?: 1 | 2 | null } = {}): HistoryGame {
  const startedAt = T0 + (opts.startMin ?? 0) * MIN;
  const teams = [team(1, { score: 2, lastNonFinalAt: startedAt + 10 * MIN }), team(2, { score: 1, lastNonFinalAt: startedAt + 5 * MIN })];
  const winnerSlot = opts.winnerSlot === undefined ? 1 : opts.winnerSlot;
  return {
    code,
    status: "finished",
    isTest: false,
    startedAt,
    endedAt: startedAt + 60 * MIN,
    endReason: "timeout",
    winnerTeamId: winnerSlot === null ? null : teams[winnerSlot - 1]!.id,
    teams,
  };
}

function abandoned(code: string, opts: { startedAt?: number | null; endedAt?: number; teams?: HistoryTeam[] } = {}): HistoryGame {
  const startedAt = opts.startedAt === undefined ? T0 : opts.startedAt;
  return {
    code,
    status: "abandoned",
    isTest: false,
    startedAt,
    endedAt: opts.endedAt ?? T0 + 3 * MIN,
    endReason: null,
    winnerTeamId: null,
    teams: opts.teams ?? [team(1), team(2)],
  };
}

describe("§9 records with no games", () => {
  it("computeRecords([]) is {null, null, 0}", () => {
    expect(computeRecords([])).toEqual({ fastestWin: null, fastestPuzzle: null, gamesPlayed: 0 });
  });

  it("each record function on [] agrees", () => {
    expect(fastestWin([])).toBeNull();
    expect(fastestPuzzle([])).toBeNull();
    expect(gamesPlayed([])).toBe(0);
  });

  it("only abandoned and test games is still {null, null, 0}", () => {
    const test = { ...win("TESTA", 10), isTest: true };
    expect(computeRecords([abandoned("ABAND"), test])).toEqual({ fastestWin: null, fastestPuzzle: null, gamesPlayed: 0 });
  });
});

describe("§9 recordEligible: finished and not a test game", () => {
  it("a finished completion win is eligible", () => {
    expect(recordEligible(win("AAAAA", 30))).toBe(true);
  });

  it("a timeout (with a winner or tied) is eligible", () => {
    expect(recordEligible(timeout("BBBBB"))).toBe(true);
    expect(recordEligible(timeout("CCCCC", { winnerSlot: null }))).toBe(true);
  });

  it("an abandoned game is not eligible", () => {
    expect(recordEligible(abandoned("DDDDD"))).toBe(false);
  });

  it("a finished test game is not eligible", () => {
    expect(recordEligible({ ...win("EEEEE", 30), isTest: true })).toBe(false);
  });
});

describe("§9 fastest win", () => {
  it("is the completed win with the smallest elapsed time; teamName is the winner's", () => {
    const a = win("AAAAA", 40);
    const b = win("BBBBB", 25, { startMin: 100, winnerSlot: 2, names: ["Reds", "Blues"] });
    const c = win("CCCCC", 30, { startMin: 200 });
    expect(fastestWin([a, b, c])).toEqual({ code: "BBBBB", teamName: "Blues", ms: 25 * MIN, endedAt: b.endedAt });
  });

  it("a tie on time goes to the earlier endedAt", () => {
    const later = win("AAAAA", 20, { startMin: 500 });
    const earlier = win("ZZZZZ", 20, { startMin: 100, names: ["Greens", "Golds"] });
    expect(fastestWin([later, earlier])).toEqual({ code: "ZZZZZ", teamName: "Greens", ms: 20 * MIN, endedAt: earlier.endedAt });
    expect(fastestWin([earlier, later])?.code).toBe("ZZZZZ");
  });

  it("a tie on time and endedAt goes to the lower code alphabetically", () => {
    const b = win("BCDEF", 20, { names: ["Greens", "Golds"] });
    const a = win("ABCDE", 20, { names: ["Reds", "Blues"] });
    expect(fastestWin([b, a])).toEqual({ code: "ABCDE", teamName: "Reds", ms: 20 * MIN, endedAt: a.endedAt });
    expect(fastestWin([a, b])?.code).toBe("ABCDE");
  });

  it("a timeout win is excluded even though it is the only win, but counts in games played", () => {
    const t = timeout("TTTTT");
    expect(fastestWin([t])).toBeNull();
    expect(gamesPlayed([t])).toBe(1);
  });

  it("a timeout never beats a slower completed win", () => {
    // A timeout always lasts 60 min, so make the completed win slower on paper by
    // shortening the timeout's recorded span: the rule is end_reason, not the time.
    const t = { ...timeout("TTTTT"), endedAt: T0 + 5 * MIN };
    const w = win("WWWWW", 50, { startMin: 100 });
    expect(fastestWin([t, w])?.code).toBe("WWWWW");
  });

  it("a tied timeout (no winner) counts in games played and has no fastest win", () => {
    const tie = timeout("TIEDD", { winnerSlot: null });
    expect(computeRecords([tie])).toEqual({ fastestWin: null, fastestPuzzle: null, gamesPlayed: 1 });
  });

  it("an abandoned game is excluded", () => {
    // Even an abandoned game with a short span never counts.
    const ab = abandoned("ABAND", { endedAt: T0 + MIN });
    const w = win("WWWWW", 45, { startMin: 100 });
    expect(fastestWin([ab, w])?.code).toBe("WWWWW");
    expect(fastestWin([ab])).toBeNull();
  });

  it("a test game is excluded", () => {
    const test = { ...win("TESTA", 5), isTest: true };
    const w = win("WWWWW", 45, { startMin: 100 });
    expect(fastestWin([test, w])?.code).toBe("WWWWW");
    expect(fastestWin([test])).toBeNull();
  });
});

describe("§9 fastest puzzle: from a team's last non-final completion to its puzzle completion", () => {
  it("the undo-and-redo example: A @5, B @10, undo A @12, redo A @20, final @30 is 10 min", () => {
    // Final team_tasks state: A = 20 (the redo), B = 10, so the last non-final is 20.
    const startedAt = T0;
    const reds = team(1, { name: "Reds", score: 3, lastNonFinalAt: startedAt + 20 * MIN, finalAt: startedAt + 30 * MIN });
    const blues = team(2, { name: "Blues", score: 1, lastNonFinalAt: startedAt + 7 * MIN });
    const g: HistoryGame = {
      code: "REDOO",
      status: "finished",
      isTest: false,
      startedAt,
      endedAt: startedAt + 30 * MIN,
      endReason: "completed",
      winnerTeamId: reds.id,
      teams: [reds, blues],
    };
    expect(puzzleMs(reds, startedAt)).toBe(10 * MIN);
    expect(fastestPuzzle([g])).toEqual({ code: "REDOO", teamName: "Reds", ms: 10 * MIN, endedAt: g.endedAt });
  });

  it("is the minimum across games, independent of the fastest win", () => {
    // Game A: faster win (20 min) but a 9-min puzzle. Game B: slower win, 2-min puzzle.
    const a = win("AAAAA", 20);
    a.teams[0]!.lastNonFinalAt = a.endedAt! - 9 * MIN;
    const b = win("BBBBB", 50, { startMin: 100, winnerSlot: 2, names: ["Greens", "Golds"] });
    b.teams[1]!.lastNonFinalAt = b.endedAt! - 2 * MIN;
    expect(fastestPuzzle([a, b])).toEqual({ code: "BBBBB", teamName: "Golds", ms: 2 * MIN, endedAt: b.endedAt });
    expect(fastestWin([a, b])?.code).toBe("AAAAA");
  });

  it("a team with no final completion is ignored", () => {
    const g = win("AAAAA", 30);
    // The loser finished all its non-final tasks a second before the end but never the final.
    g.teams[1]!.lastNonFinalAt = g.endedAt! - 1000;
    g.teams[1]!.finalAt = null;
    expect(puzzleMs(g.teams[1]!, g.startedAt)).toBeNull();
    expect(fastestPuzzle([g])).toEqual({ code: "AAAAA", teamName: "Reds", ms: 5 * MIN, endedAt: g.endedAt });
  });

  it("falls back to startedAt when the team has no non-final completion", () => {
    const t = team(1, { lastNonFinalAt: null, finalAt: T0 + 7 * MIN });
    expect(puzzleMs(t, T0)).toBe(7 * MIN);
  });

  it("is null when there is neither a non-final completion nor a start", () => {
    expect(puzzleMs(team(1, { lastNonFinalAt: null, finalAt: T0 }), null)).toBeNull();
  });

  it("is null without a final completion, whatever else is set", () => {
    expect(puzzleMs(team(1, { lastNonFinalAt: T0 + MIN, finalAt: null }), T0)).toBeNull();
    expect(puzzleMs(team(1), T0)).toBeNull();
  });

  it("a tie on time goes to the earlier endedAt, then the lower code", () => {
    const late = win("AAAAA", 30, { startMin: 300 });
    const early = win("YYYYY", 30, { startMin: 100, names: ["Greens", "Golds"] });
    const earlyTwin = win("XXXXX", 30, { startMin: 100, names: ["Pinks", "Greys"] });
    // All three have a 5-min puzzle.
    expect(fastestPuzzle([late, early, earlyTwin])).toEqual({ code: "XXXXX", teamName: "Pinks", ms: 5 * MIN, endedAt: early.endedAt });
    expect(fastestPuzzle([late, early])?.code).toBe("YYYYY");
  });

  it("abandoned and test games are excluded", () => {
    const ab = abandoned("ABAND", { teams: [team(1, { lastNonFinalAt: T0, finalAt: T0 + 1000 }), team(2)] });
    const test = { ...win("TESTA", 10), isTest: true };
    test.teams[0]!.lastNonFinalAt = test.endedAt! - 1000;
    const w = win("WWWWW", 40, { startMin: 100 });
    expect(fastestPuzzle([ab, test, w])).toEqual({ code: "WWWWW", teamName: "Reds", ms: 5 * MIN, endedAt: w.endedAt });
    expect(fastestPuzzle([ab, test])).toBeNull();
  });

  it("an eligible game where nobody reached the final gives null", () => {
    expect(fastestPuzzle([timeout("TTTTT")])).toBeNull();
  });
});

describe("§9 games played: finished, non-test games", () => {
  it("counts completions, timeouts and timeout ties; not abandoned or test games", () => {
    const games = [
      win("AAAAA", 30),
      timeout("BBBBB"),
      timeout("CCCCC", { winnerSlot: null }),
      abandoned("DDDDD"),
      abandoned("EEEEE", { startedAt: null }),
      { ...win("FFFFF", 20), isTest: true },
      { ...timeout("GGGGG"), isTest: true },
    ];
    expect(gamesPlayed(games)).toBe(3);
    expect(computeRecords(games).gamesPlayed).toBe(3);
  });
});

describe("§9 computeRecords combines the three", () => {
  it("matches the individual functions", () => {
    const games = [win("AAAAA", 40), win("BBBBB", 25, { startMin: 100 }), timeout("CCCCC", { startMin: 200 }), abandoned("DDDDD")];
    expect(computeRecords(games)).toEqual({
      fastestWin: fastestWin(games),
      fastestPuzzle: fastestPuzzle(games),
      gamesPlayed: 3,
    });
    expect(computeRecords(games).fastestWin?.code).toBe("BBBBB");
  });
});

describe("§9 elapsedMs (duration)", () => {
  it("is endedAt − startedAt", () => {
    expect(elapsedMs(win("AAAAA", 30))).toBe(30 * MIN);
    expect(elapsedMs(timeout("BBBBB"))).toBe(60 * MIN);
    expect(elapsedMs(abandoned("CCCCC", { startedAt: T0, endedAt: T0 + 7 * MIN }))).toBe(7 * MIN);
  });

  it("is null for a game that never started", () => {
    expect(elapsedMs(abandoned("DDDDD", { startedAt: null, endedAt: T0 + MIN }))).toBeNull();
  });

  it("is null without an endedAt", () => {
    expect(elapsedMs({ ...win("EEEEE", 30), endedAt: null })).toBeNull();
  });
});

describe("§9 splitMs (each team's split per task, from the start)", () => {
  it("is completedAt − startedAt", () => {
    expect(splitMs(T0, T0 + 12 * MIN + 34_000)).toBe(12 * MIN + 34_000);
    expect(splitMs(T0, T0)).toBe(0);
  });

  it("is null for a task not done", () => {
    expect(splitMs(T0, null)).toBeNull();
  });

  it("is null for a game that never started", () => {
    expect(splitMs(null, T0)).toBeNull();
    expect(splitMs(null, null)).toBeNull();
  });
});
