// SPEC.md §9 /history and /history/:code: durations, split times ("minutes from start"),
// dates, results (winner, tie, abandoned) and end reasons. Approved M5 format: m:ss,
// floored to whole seconds, minutes never roll into hours, "—" for null, negatives clamp.
import { describe, expect, it } from "vitest";
import { endReasonText, formatDate, formatElapsed, resultText } from "../src/client/history/format";

const SEC = 1000;
const MIN = 60 * SEC;

describe("§9 formatElapsed (m:ss)", () => {
  it.each([
    [0, "0:00"],
    [999, "0:00"],
    [SEC, "0:01"],
    [59 * SEC, "0:59"],
    [59_999, "0:59"],
    [MIN, "1:00"],
    [MIN + 5 * SEC, "1:05"],
    [12 * MIN + 34 * SEC, "12:34"],
    [12 * MIN + 34 * SEC + 999, "12:34"],
    [59 * MIN + 59 * SEC + 999, "59:59"],
    [60 * MIN, "60:00"],
    [62 * MIN + 5 * SEC, "62:05"],
  ])("%i ms → %s", (ms, text) => {
    expect(formatElapsed(ms)).toBe(text);
  });

  it("null → —", () => {
    expect(formatElapsed(null)).toBe("—");
  });

  it.each([-1, -999, -MIN])("a negative value (%i) clamps to 0:00", (ms) => {
    expect(formatElapsed(ms)).toBe("0:00");
  });
});

describe("§9 formatDate", () => {
  it("includes the year and day of a fixed UTC date", () => {
    const text = formatDate(Date.UTC(2026, 9, 20, 12, 0, 0), "UTC");
    expect(text).toContain("2026");
    expect(text).toMatch(/\b20\b/);
  });

  it("uses the given time zone for the day", () => {
    // 02:00 UTC on Oct 20 is still Oct 19 in Los Angeles.
    const ms = Date.UTC(2026, 9, 20, 2, 0, 0);
    expect(formatDate(ms, "America/Los_Angeles")).toMatch(/\b19\b/);
    expect(formatDate(ms, "UTC")).toMatch(/\b20\b/);
  });
});

describe("§9 resultText", () => {
  const teams = [
    { id: 11, name: "Reds" },
    { id: 12, name: "Blues" },
  ];

  it("a finished game with a winner names the winner", () => {
    expect(resultText({ status: "finished", winnerTeamId: 11, teams })).toBe("Reds won");
    expect(resultText({ status: "finished", winnerTeamId: 12, teams })).toBe("Blues won");
  });

  it("a finished game without a winner is a tie", () => {
    expect(resultText({ status: "finished", winnerTeamId: null, teams })).toBe("Tie");
  });

  it("an abandoned game is labeled", () => {
    expect(resultText({ status: "abandoned", winnerTeamId: null, teams })).toBe("Abandoned");
  });
});

describe("§9 endReasonText", () => {
  it("completed → Puzzle solved", () => {
    expect(endReasonText({ status: "finished", endReason: "completed", startedAt: 1 })).toBe("Puzzle solved");
  });

  it("timeout → Time ran out", () => {
    expect(endReasonText({ status: "finished", endReason: "timeout", startedAt: 1 })).toBe("Time ran out");
  });

  it("abandoned before the start", () => {
    expect(endReasonText({ status: "abandoned", endReason: null, startedAt: null })).toBe("Abandoned before start");
  });

  it("abandoned after the start", () => {
    expect(endReasonText({ status: "abandoned", endReason: null, startedAt: 1 })).toBe("Abandoned");
  });
});
