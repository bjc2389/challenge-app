// SPEC.md §5 Order and the puzzle lock: the final task is locked for a team until all of
// that team's other tasks are complete; undo relocks. §9: the score is tasks done per team.
import { describe, expect, it } from "vitest";
import { isFinalUnlocked, scoreFor } from "../src/worker/game/lock";
import { FINAL_ID, NON_FINAL_IDS, STARTED_AT, TEAM_1, TEAM_2, allNonFinal, makeSnapshot } from "./helpers/snapshot";

const [A, B, C] = NON_FINAL_IDS;

describe("§5 isFinalUnlocked", () => {
  it("is locked when nothing is done", () => {
    const s = makeSnapshot();
    expect(isFinalUnlocked(s.tasks, s.teamTasks, TEAM_1)).toBe(false);
    expect(isFinalUnlocked(s.tasks, s.teamTasks, TEAM_2)).toBe(false);
  });

  it("stays locked with all but one non-final task done", () => {
    const s = makeSnapshot({ completed: [[TEAM_1, A, STARTED_AT + 1], [TEAM_1, B, STARTED_AT + 2]] });
    expect(isFinalUnlocked(s.tasks, s.teamTasks, TEAM_1)).toBe(false);
  });

  it("unlocks when every non-final task is done, per team", () => {
    const s = makeSnapshot({ completed: allNonFinal(TEAM_1) });
    expect(isFinalUnlocked(s.tasks, s.teamTasks, TEAM_1)).toBe(true);
    expect(isFinalUnlocked(s.tasks, s.teamTasks, TEAM_2)).toBe(false);
  });

  it("the other team's completions don't count", () => {
    const s = makeSnapshot({ completed: [...allNonFinal(TEAM_2), [TEAM_1, A, STARTED_AT + 1], [TEAM_1, B, STARTED_AT + 2]] });
    expect(isFinalUnlocked(s.tasks, s.teamTasks, TEAM_1)).toBe(false);
    expect(isFinalUnlocked(s.tasks, s.teamTasks, TEAM_2)).toBe(true);
  });

  it("relocks when a non-final task is undone (completedAt back to null)", () => {
    const s = makeSnapshot({ completed: allNonFinal(TEAM_1) });
    const undone = s.teamTasks.map((tt) => (tt.teamId === TEAM_1 && tt.gameTaskId === C ? { ...tt, completedAt: null } : tt));
    expect(isFinalUnlocked(s.tasks, undone, TEAM_1)).toBe(false);
  });

  it("a completion time of 0 still counts as done (non-null)", () => {
    const s = makeSnapshot({ completed: [[TEAM_1, A, 0], [TEAM_1, B, 0], [TEAM_1, C, 0]] });
    expect(isFinalUnlocked(s.tasks, s.teamTasks, TEAM_1)).toBe(true);
  });

  it("is unlocked when there are no non-final tasks", () => {
    const s = makeSnapshot();
    const finalOnly = s.tasks.filter((t) => t.isFinal);
    expect(isFinalUnlocked(finalOnly, s.teamTasks, TEAM_1)).toBe(true);
    expect(isFinalUnlocked([], [], TEAM_1)).toBe(true);
  });

  it("a missing team_tasks row counts as not done", () => {
    const s = makeSnapshot({ completed: allNonFinal(TEAM_1) });
    const missing = s.teamTasks.filter((tt) => !(tt.teamId === TEAM_1 && tt.gameTaskId === A));
    expect(isFinalUnlocked(s.tasks, missing, TEAM_1)).toBe(false);
  });
});

describe("§9 scoreFor", () => {
  it("is 0 with nothing done", () => {
    const s = makeSnapshot();
    expect(scoreFor(s.teamTasks, TEAM_1)).toBe(0);
  });

  it("counts only that team's non-null completions", () => {
    const s = makeSnapshot({ completed: [...allNonFinal(TEAM_1), [TEAM_2, A, STARTED_AT + 5]] });
    expect(scoreFor(s.teamTasks, TEAM_1)).toBe(3);
    expect(scoreFor(s.teamTasks, TEAM_2)).toBe(1);
  });

  it("counts the final task too", () => {
    const s = makeSnapshot({ completed: [...allNonFinal(TEAM_1), [TEAM_1, FINAL_ID, STARTED_AT + 10]] });
    expect(scoreFor(s.teamTasks, TEAM_1)).toBe(4);
  });

  it("counts a completion at time 0", () => {
    const s = makeSnapshot({ completed: [[TEAM_2, A, 0]] });
    expect(scoreFor(s.teamTasks, TEAM_2)).toBe(1);
  });
});
