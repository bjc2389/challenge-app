// SPEC.md §4 lifecycle and end conditions, §5 puzzle lock and undo rules, §6 version and
// "Time!", §9 game screens (scoreboard grid, lock per team, result banner, roll reveal),
// §10 GameView. Pure client helpers; the server stays authoritative.
import { describe, expect, it } from "vitest";
import type { GameStatus, GameView } from "../src/client/game/types";
import {
  cellState,
  pickNewer,
  resultBanner,
  scoreAnnouncement,
  scoreText,
  shouldReveal,
  teamBySlot,
} from "../src/client/game/view";
import { FINAL_ID, NON_FINAL_IDS, TEAM_IDS, TEAM_NAMES, makeView, taskById } from "./helpers/view-fixture";

const OPEN = { timeUp: false, pending: false };
const [A, B, C] = NON_FINAL_IDS;

/** Reds have every non-final task done (final unlocked); Blues have one (final locked). */
const midGame = (status: GameStatus = "active") => makeView({ status, done: [[A, B, C], [A]] });

describe("§9 §5 cellState: active game", () => {
  it("an open non-final task offers complete", () => {
    const view = midGame();
    const s = cellState(view, taskById(view, B), 1, OPEN);
    expect(s).toMatchObject({ checked: false, locked: false, action: "complete", busy: false });
  });

  it("a done non-final task offers undo", () => {
    const view = midGame();
    const s = cellState(view, taskById(view, A), 0, OPEN);
    expect(s).toMatchObject({ checked: true, locked: false, action: "undo", busy: false });
  });

  it("the final task is locked for a team that hasn't finished everything else", () => {
    const view = midGame();
    expect(view.teams[1]?.finalUnlocked).toBe(false);
    const s = cellState(view, taskById(view, FINAL_ID), 1, OPEN);
    expect(s).toMatchObject({ checked: false, locked: true, action: null });
  });

  it("the final task is unlocked and completable for a team that has", () => {
    const view = midGame();
    expect(view.teams[0]?.finalUnlocked).toBe(true);
    const s = cellState(view, taskById(view, FINAL_ID), 0, OPEN);
    expect(s).toMatchObject({ checked: false, locked: false, action: "complete" });
  });

  it("locking follows the team's finalUnlocked flag from the server", () => {
    const view = makeView({ done: [[A, B, C], []], teams: [{ finalUnlocked: false }, { finalUnlocked: true }] });
    expect(cellState(view, taskById(view, FINAL_ID), 0, OPEN)).toMatchObject({ locked: true, action: null });
    expect(cellState(view, taskById(view, FINAL_ID), 1, OPEN)).toMatchObject({ locked: false, action: "complete" });
  });

  it("non-final tasks are never locked", () => {
    const view = midGame();
    for (const id of NON_FINAL_IDS) {
      expect(cellState(view, taskById(view, id), 1, OPEN).locked).toBe(false);
    }
  });

  it("a done final task can't be undone, and isn't shown as locked", () => {
    const view = makeView({ done: [[A, B, C, FINAL_ID], []], teams: [{ finalUnlocked: false }] });
    const s = cellState(view, taskById(view, FINAL_ID), 0, OPEN);
    expect(s).toMatchObject({ checked: true, locked: false, action: null });
  });
});

describe("§4 §9 cellState: read-only outside active, checks still shown", () => {
  it.each(["setup", "rolled", "finished", "abandoned"] as const)("%s", (status) => {
    // A setup game has no tasks; reuse the rolled board with the status forced, so the
    // read-only rule is checked against real cells.
    const base = midGame(status === "setup" ? "rolled" : status);
    const view: GameView = { ...base, game: { ...base.game, status } };
    expect(view.game.status).toBe(status);
    for (const task of view.tasks) {
      for (const slotIndex of [0, 1] as const) {
        const s = cellState(view, task, slotIndex, OPEN);
        expect(s.action).toBeNull();
        expect(s.checked).toBe(task.completedAt[slotIndex] !== null);
      }
    }
    expect(cellState(view, taskById(view, A), 0, OPEN).checked).toBe(true);
    expect(cellState(view, taskById(view, A), 1, OPEN).checked).toBe(true);
    expect(cellState(view, taskById(view, B), 1, OPEN).checked).toBe(false);
  });

  it("a finished game still shows the winner's final task as checked", () => {
    const view = makeView({ status: "finished", done: [[A, B, C, FINAL_ID], [A]] });
    expect(cellState(view, taskById(view, FINAL_ID), 0, OPEN)).toMatchObject({ checked: true, action: null });
  });
});

describe("§6 §9 cellState: time up and pending block taps", () => {
  it("timeUp blocks every cell but keeps checks", () => {
    const view = midGame();
    const opts = { timeUp: true, pending: false };
    for (const task of view.tasks) {
      for (const slotIndex of [0, 1] as const) {
        const s = cellState(view, task, slotIndex, opts);
        expect(s.action).toBeNull();
        expect(s.busy).toBe(false);
      }
    }
    expect(cellState(view, taskById(view, A), 0, opts).checked).toBe(true);
  });

  it("pending blocks the cell and marks it busy", () => {
    const view = midGame();
    const opts = { timeUp: false, pending: true };
    const done = cellState(view, taskById(view, A), 0, opts);
    const open = cellState(view, taskById(view, B), 1, opts);
    expect(done).toMatchObject({ checked: true, action: null, busy: true });
    expect(open).toMatchObject({ checked: false, action: null, busy: true });
  });

  it("busy is false when not pending", () => {
    const view = midGame();
    expect(cellState(view, taskById(view, B), 1, OPEN).busy).toBe(false);
  });
});

describe("§9 cellState labels", () => {
  it("a done cell names the team and task and says done", () => {
    const view = midGame();
    const { label } = cellState(view, taskById(view, A), 0, OPEN);
    expect(label).toContain(TEAM_NAMES[0]);
    expect(label).toContain("Drink A");
    expect(label).toContain("done");
    expect(label).not.toContain("not done");
    expect(label).not.toContain("locked");
  });

  it("an open cell says not done", () => {
    const view = midGame();
    const { label } = cellState(view, taskById(view, B), 1, OPEN);
    expect(label).toContain(TEAM_NAMES[1]);
    expect(label).toContain("Drink B");
    expect(label).toContain("not done");
  });

  it("a locked final cell says locked", () => {
    const view = midGame();
    const { label } = cellState(view, taskById(view, FINAL_ID), 1, OPEN);
    expect(label).toContain(TEAM_NAMES[1]);
    expect(label).toContain("Puzzle A");
    expect(label).toContain("locked");
  });
});

describe("§9 §10 scores", () => {
  it("teamBySlot finds each team by slot", () => {
    const view = midGame();
    expect(teamBySlot(view, 1).id).toBe(TEAM_IDS[0]);
    expect(teamBySlot(view, 2).id).toBe(TEAM_IDS[1]);
  });

  it("teamBySlot uses slot, not array position", () => {
    const view = midGame();
    const swapped: GameView = { ...view, teams: [...view.teams].reverse() };
    expect(teamBySlot(swapped, 1).name).toBe(TEAM_NAMES[0]);
    expect(teamBySlot(swapped, 2).name).toBe(TEAM_NAMES[1]);
  });

  it("scoreText is done/total", () => {
    const view = midGame();
    expect(scoreText(view, teamBySlot(view, 1))).toBe("3/4");
    expect(scoreText(view, teamBySlot(view, 2))).toBe("1/4");
  });

  it("scoreText before any completion", () => {
    const view = makeView({ status: "rolled" });
    expect(scoreText(view, teamBySlot(view, 1))).toBe("0/4");
  });

  it("scoreAnnouncement lists names and scores in slot order", () => {
    expect(scoreAnnouncement(midGame())).toBe("Reds 3, Blues 1");
  });
});

describe("§4 §9 resultBanner", () => {
  it.each(["setup", "rolled", "active"] as const)("null while %s", (status) => {
    expect(resultBanner(makeView({ status }))).toBeNull();
  });

  it("abandoned", () => {
    expect(resultBanner(makeView({ status: "abandoned" }))?.title).toBe("Game abandoned");
  });

  it("a completion win names the winner and mentions the puzzle", () => {
    const view = makeView({
      status: "finished",
      done: [[A], [A, B, C, FINAL_ID]],
      game: { endReason: "completed", winnerTeamId: TEAM_IDS[1] },
    });
    const banner = resultBanner(view);
    expect(banner?.title).toBe("Blues wins!");
    expect(banner?.detail.toLowerCase()).toContain("puzzle");
  });

  it("a timeout win names the winner and mentions time", () => {
    const view = makeView({
      status: "finished",
      done: [[A, B], [A]],
      game: { endReason: "timeout", winnerTeamId: TEAM_IDS[0] },
    });
    const banner = resultBanner(view);
    expect(banner?.title).toBe("Reds wins!");
    expect(banner?.detail.toLowerCase()).toContain("time");
  });

  it("a tie", () => {
    const view = makeView({
      status: "finished",
      done: [[A], [B]],
      game: { endReason: "timeout", winnerTeamId: null },
    });
    const banner = resultBanner(view);
    expect(banner?.title).toBe("It's a tie!");
    expect(typeof banner?.detail).toBe("string");
  });
});

describe("§6 pickNewer", () => {
  it("null current gives incoming", () => {
    const incoming = makeView({ version: 3 });
    expect(pickNewer(null, incoming)).toBe(incoming);
  });

  it("a higher version wins", () => {
    const current = makeView({ version: 3 });
    const incoming = makeView({ version: 4 });
    expect(pickNewer(current, incoming)).toBe(incoming);
  });

  it("an equal version takes incoming", () => {
    const current = makeView({ version: 3 });
    const incoming = makeView({ version: 3, serverNow: current.serverNow + 3_000 });
    expect(pickNewer(current, incoming)).toBe(incoming);
  });

  it("a lower version keeps current", () => {
    const current = makeView({ version: 5 });
    expect(pickNewer(current, makeView({ version: 4 }))).toBe(current);
  });
});

describe("§9 shouldReveal (roll reveal)", () => {
  it("setup -> rolled reveals", () => {
    expect(shouldReveal("setup", "rolled")).toBe(true);
  });

  it.each([
    [null, "rolled"],
    ["rolled", "rolled"],
    ["setup", "setup"],
    ["setup", "active"],
    ["rolled", "active"],
    ["setup", "abandoned"],
    [null, "active"],
    ["active", "finished"],
  ] as const)("%j -> %j does not", (prev, next) => {
    expect(shouldReveal(prev, next)).toBe(false);
  });
});
