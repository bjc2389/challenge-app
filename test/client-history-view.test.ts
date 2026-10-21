// SPEC.md §9 /history (records block: fastest win, fastest puzzle, games played; result per
// game) and /history/:code (each team's split per task, the full event log including
// undos). Pure client helpers over the API shapes; no DOM.
import { describe, expect, it } from "vitest";
import { formatElapsed } from "../src/client/history/format";
import type { HistoryDetail, HistoryItem, HistoryList } from "../src/client/history/types";
import { eventRows, recordRows, scoreLine, splitRows } from "../src/client/history/view";

const MIN = 60_000;
const S = Date.UTC(2026, 9, 20, 12, 2, 0);

function item(over: Partial<HistoryItem> = {}): HistoryItem {
  return {
    code: "ABCDE",
    status: "finished",
    startedAt: S,
    endedAt: S + 30 * MIN,
    elapsedMs: 30 * MIN,
    endReason: "completed",
    winnerTeamId: 11,
    teams: [
      { id: 11, slot: 1, name: "Reds", score: 4 },
      { id: 12, slot: 2, name: "Blues", score: 3 },
    ],
    ...over,
  };
}

function detail(): HistoryDetail {
  return {
    game: {
      code: "ABCDE",
      status: "finished",
      createdAt: S - 2 * MIN,
      startedAt: S,
      endsAt: S + 60 * MIN,
      endedAt: S + 30 * MIN,
      endReason: "completed",
      winnerTeamId: 11,
      elapsedMs: 30 * MIN,
    },
    teams: [
      { id: 11, slot: 1, name: "Reds", score: 2, puzzleMs: 10 * MIN },
      { id: 12, slot: 2, name: "Blues", score: 1, puzzleMs: null },
    ],
    tasks: [
      { id: 101, sortOrder: 1, categoryName: "Tough Drink", text: "Four Loko", isFinal: false, splitMs: [20 * MIN, 6 * MIN + 7_500] },
      { id: 102, sortOrder: 2, categoryName: "Final Puzzle", text: "250-piece puzzle", isFinal: true, splitMs: [30 * MIN, null] },
    ],
    events: [
      { id: 1, at: S + 5 * MIN, sinceStartMs: 5 * MIN, teamId: 11, taskId: 101, action: "complete" },
      { id: 2, at: S + 6 * MIN + 7_500, sinceStartMs: 6 * MIN + 7_500, teamId: 12, taskId: 101, action: "complete" },
      { id: 3, at: S + 12 * MIN, sinceStartMs: 12 * MIN, teamId: 11, taskId: 101, action: "undo" },
      { id: 4, at: S + 20 * MIN, sinceStartMs: 20 * MIN, teamId: 11, taskId: 101, action: "complete" },
      { id: 5, at: S + 30 * MIN, sinceStartMs: 30 * MIN, teamId: 11, taskId: 102, action: "complete" },
    ],
  };
}

describe("§9 scoreLine", () => {
  it("is 'Slot1 n – m Slot2' with an en dash and spaces", () => {
    expect(scoreLine(item())).toBe("Reds 4 – 3 Blues");
  });

  it("orders by slot, not by array position", () => {
    const it2 = item({
      teams: [
        { id: 12, slot: 2, name: "Blues", score: 3 },
        { id: 11, slot: 1, name: "Reds", score: 4 },
      ],
    });
    expect(scoreLine(it2)).toBe("Reds 4 – 3 Blues");
  });

  it("shows 0 – 0 for a game abandoned in setup", () => {
    const ab = item({
      status: "abandoned",
      startedAt: null,
      elapsedMs: null,
      endReason: null,
      winnerTeamId: null,
      teams: [
        { id: 11, slot: 1, name: "Team 1", score: 0 },
        { id: 12, slot: 2, name: "Team 2", score: 0 },
      ],
    });
    expect(scoreLine(ab)).toBe("Team 1 0 – 0 Team 2");
  });
});

describe("§9 recordRows: fastest win, fastest puzzle, games played", () => {
  it("empty records: two '—' rows with 'No games yet', then games played '0'", () => {
    const records: HistoryList["records"] = { fastestWin: null, fastestPuzzle: null, gamesPlayed: 0 };
    const rows = recordRows(records);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.label).toMatch(/fastest win/i);
    expect(rows[1]!.label).toMatch(/fastest puzzle/i);
    expect(rows[2]!.label).toMatch(/games played/i);
    expect(rows[0]).toMatchObject({ value: "—", holder: "No games yet" });
    expect(rows[1]).toMatchObject({ value: "—", holder: "No games yet" });
    expect(rows[2]!.value).toBe("0");
  });

  it("filled records: values formatted m:ss, holders name the team; games played as a string", () => {
    const rows = recordRows({
      fastestWin: { code: "ABCDE", teamName: "Reds", ms: 23 * MIN + 45_000, endedAt: S },
      fastestPuzzle: { code: "BCDEF", teamName: "Blues", ms: 4 * MIN + 2_900, endedAt: S },
      gamesPlayed: 12,
    });
    expect(rows.map((r) => r.value)).toEqual(["23:45", "4:02", "12"]);
    expect(rows[0]!.holder).toContain("Reds");
    expect(rows[1]!.holder).toContain("Blues");
  });

  it("one record set, the other empty", () => {
    const rows = recordRows({
      fastestWin: null,
      fastestPuzzle: { code: "BCDEF", teamName: "Blues", ms: MIN, endedAt: S },
      gamesPlayed: 1,
    });
    expect(rows[0]).toMatchObject({ value: "—", holder: "No games yet" });
    expect(rows[1]).toMatchObject({ value: "1:00" });
    expect(rows[2]!.value).toBe("1");
  });
});

describe("§9 eventRows: the full event log including undos", () => {
  it("one row per event with '+m:ss' and 'Team verb Task'", () => {
    expect(eventRows(detail())).toEqual([
      { time: "+5:00", text: "Reds completed Four Loko" },
      { time: "+6:07", text: "Blues completed Four Loko" },
      { time: "+12:00", text: "Reds undid Four Loko" },
      { time: "+20:00", text: "Reds completed Four Loko" },
      { time: "+30:00", text: "Reds completed 250-piece puzzle" },
    ]);
  });

  it("keeps the order it was given (the server orders by at, then id)", () => {
    const d = detail();
    d.events = [d.events[2]!, d.events[0]!];
    expect(eventRows(d).map((r) => r.text)).toEqual(["Reds undid Four Loko", "Reds completed Four Loko"]);
  });

  it("no events gives no rows", () => {
    const d = detail();
    d.events = [];
    expect(eventRows(d)).toEqual([]);
  });
});

describe("§9 splitRows: each team's split per task", () => {
  it("one row per task, times by slot through formatElapsed, '—' when not done", () => {
    expect(splitRows(detail())).toEqual([
      { task: "Four Loko", times: ["20:00", "6:07"] },
      { task: "250-piece puzzle", times: ["30:00", "—"] },
    ]);
  });

  it("matches formatElapsed for every cell", () => {
    const d = detail();
    const rows = splitRows(d);
    d.tasks.forEach((t, i) => {
      expect(rows[i]!.times).toEqual([formatElapsed(t.splitMs[0] ?? null), formatElapsed(t.splitMs[1] ?? null)]);
    });
  });

  it("no tasks (abandoned in setup) gives no rows", () => {
    const d = detail();
    d.tasks = [];
    expect(splitRows(d)).toEqual([]);
  });
});
