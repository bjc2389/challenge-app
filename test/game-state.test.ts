// SPEC.md §4 lifecycle and §5 complete/undo rules as pure decisions.
// Check order per the approved M3 plan: status, deadline, team, task, then task-specific rules.
import { describe, expect, it } from "vitest";
import { ALLOWED, canDo, decideComplete, decideUndo, type Action } from "../src/worker/game/state";
import type { Decision, GameStatus } from "../src/worker/game/types";
import {
  ENDS_AT,
  FINAL_ID,
  NON_FINAL_IDS,
  OTHER_TASK,
  OTHER_TEAM,
  STARTED_AT,
  TEAM_1,
  TEAM_2,
  allNonFinal,
  makeSnapshot,
} from "./helpers/snapshot";

const [A, B] = NON_FINAL_IDS;
const NOW = STARTED_AT + 10 * 60_000;

function expectErrorDecision(d: Decision, status: number, error: string) {
  expect(d).toMatchObject({ kind: "error", status, error });
  if (d.kind === "error") {
    expect(typeof d.message).toBe("string");
    expect(d.message.length).toBeGreaterThan(0);
  }
}

const STATUSES: GameStatus[] = ["setup", "rolled", "active", "finished", "abandoned"];
const ACTIONS: Action[] = ["roll", "renameTeams", "start", "complete", "undo", "abandon"];

describe("§4 ALLOWED and canDo", () => {
  it("matches the lifecycle table exactly", () => {
    expect(ALLOWED).toEqual({
      roll: ["setup"],
      renameTeams: ["setup", "rolled"],
      start: ["rolled"],
      complete: ["active"],
      undo: ["active"],
      abandon: ["setup", "rolled", "active"],
    });
  });

  const expected: Record<Action, GameStatus[]> = {
    roll: ["setup"],
    renameTeams: ["setup", "rolled"],
    start: ["rolled"],
    complete: ["active"],
    undo: ["active"],
    abandon: ["setup", "rolled", "active"],
  };
  const cases = ACTIONS.flatMap((action) =>
    STATUSES.map((status) => [action, status, expected[action].includes(status)] as const),
  );

  it.each(cases)("canDo(%s in %s) is %s", (action, status, allowed) => {
    expect(canDo(status, action)).toBe(allowed);
  });

  it("finished and abandoned allow nothing", () => {
    for (const action of ACTIONS) {
      expect(canDo("finished", action)).toBe(false);
      expect(canDo("abandoned", action)).toBe(false);
    }
  });
});

describe.each([
  ["decideComplete", decideComplete],
  ["decideUndo", decideUndo],
] as const)("§4 §5 %s shared checks", (_name, decide) => {
  it.each<[GameStatus, string]>([
    ["setup", "invalid_state"],
    ["rolled", "invalid_state"],
    ["finished", "game_over"],
    ["abandoned", "game_over"],
  ])("status %s gives 409 %s", (status, error) => {
    expectErrorDecision(decide(makeSnapshot({ status }), TEAM_1, A, NOW), 409, error);
  });

  it("the status check comes before team and task checks", () => {
    expectErrorDecision(decide(makeSnapshot({ status: "finished" }), OTHER_TEAM, OTHER_TASK, NOW), 409, "game_over");
    expectErrorDecision(decide(makeSnapshot({ status: "rolled" }), OTHER_TEAM, OTHER_TASK, NOW), 409, "invalid_state");
  });

  it("at exactly ends_at gives 409 game_over", () => {
    expectErrorDecision(decide(makeSnapshot({ completed: [[TEAM_1, A, NOW]] }), TEAM_1, A, ENDS_AT), 409, "game_over");
  });

  it("after ends_at gives 409 game_over", () => {
    expectErrorDecision(decide(makeSnapshot({ completed: [[TEAM_1, A, NOW]] }), TEAM_1, A, ENDS_AT + 1), 409, "game_over");
  });

  it("the deadline check comes before team and task checks", () => {
    expectErrorDecision(decide(makeSnapshot(), OTHER_TEAM, OTHER_TASK, ENDS_AT), 409, "game_over");
  });

  it("a team that isn't in this game gives 422 validation", () => {
    expectErrorDecision(decide(makeSnapshot(), OTHER_TEAM, A, NOW), 422, "validation");
  });

  it("the team check comes before the task check", () => {
    expectErrorDecision(decide(makeSnapshot(), OTHER_TEAM, OTHER_TASK, NOW), 422, "validation");
  });

  it("a task that isn't in this game gives 404 not_found", () => {
    expectErrorDecision(decide(makeSnapshot(), TEAM_1, OTHER_TASK, NOW), 404, "not_found");
  });
});

describe("§5 decideComplete", () => {
  it("completes a non-final task with finish null", () => {
    expect(decideComplete(makeSnapshot(), TEAM_2, B, NOW)).toEqual({
      kind: "change",
      change: { kind: "complete", teamId: TEAM_2, gameTaskId: B, at: NOW, finish: null },
    });
  });

  it("succeeds at ends_at - 1", () => {
    expect(decideComplete(makeSnapshot(), TEAM_1, A, ENDS_AT - 1)).toEqual({
      kind: "change",
      change: { kind: "complete", teamId: TEAM_1, gameTaskId: A, at: ENDS_AT - 1, finish: null },
    });
  });

  it("is a noop when this team already completed the task", () => {
    expect(decideComplete(makeSnapshot({ completed: [[TEAM_1, A, NOW - 1000]] }), TEAM_1, A, NOW)).toEqual({ kind: "noop" });
  });

  it("is a change when only the other team completed the task", () => {
    const d = decideComplete(makeSnapshot({ completed: [[TEAM_1, A, NOW - 1000]] }), TEAM_2, A, NOW);
    expect(d).toEqual({ kind: "change", change: { kind: "complete", teamId: TEAM_2, gameTaskId: A, at: NOW, finish: null } });
  });

  it("the final task is locked with nothing done: 409 final_locked", () => {
    expectErrorDecision(decideComplete(makeSnapshot(), TEAM_1, FINAL_ID, NOW), 409, "final_locked");
  });

  it("the final task stays locked with one non-final task left", () => {
    const s = makeSnapshot({ completed: allNonFinal(TEAM_1).slice(0, 2) });
    expectErrorDecision(decideComplete(s, TEAM_1, FINAL_ID, NOW), 409, "final_locked");
  });

  it("the lock is per team: team 1 done doesn't unlock team 2", () => {
    const s = makeSnapshot({ completed: allNonFinal(TEAM_1) });
    expectErrorDecision(decideComplete(s, TEAM_2, FINAL_ID, NOW), 409, "final_locked");
  });

  it("completing the unlocked final task finishes the game with that team as winner", () => {
    const s = makeSnapshot({ completed: allNonFinal(TEAM_2) });
    expect(decideComplete(s, TEAM_2, FINAL_ID, NOW)).toEqual({
      kind: "change",
      change: { kind: "complete", teamId: TEAM_2, gameTaskId: FINAL_ID, at: NOW, finish: { winnerTeamId: TEAM_2 } },
    });
  });

  it("the deadline beats an unlocked final", () => {
    const s = makeSnapshot({ completed: allNonFinal(TEAM_1) });
    expectErrorDecision(decideComplete(s, TEAM_1, FINAL_ID, ENDS_AT), 409, "game_over");
  });

  it("an already-completed non-final task is a noop even though the final is locked", () => {
    const s = makeSnapshot({ completed: [[TEAM_1, B, NOW - 5]] });
    expect(decideComplete(s, TEAM_1, B, NOW)).toEqual({ kind: "noop" });
  });
});

describe("§5 decideUndo", () => {
  it("undoes a completed non-final task", () => {
    const s = makeSnapshot({ completed: [[TEAM_1, A, NOW - 1000]] });
    expect(decideUndo(s, TEAM_1, A, NOW)).toEqual({
      kind: "change",
      change: { kind: "undo", teamId: TEAM_1, gameTaskId: A, at: NOW },
    });
  });

  it("succeeds at ends_at - 1", () => {
    const s = makeSnapshot({ completed: [[TEAM_2, B, NOW]] });
    expect(decideUndo(s, TEAM_2, B, ENDS_AT - 1)).toEqual({
      kind: "change",
      change: { kind: "undo", teamId: TEAM_2, gameTaskId: B, at: ENDS_AT - 1 },
    });
  });

  it("is a noop when the task isn't completed by this team", () => {
    expect(decideUndo(makeSnapshot(), TEAM_1, A, NOW)).toEqual({ kind: "noop" });
  });

  it("is a noop when only the other team completed the task", () => {
    const s = makeSnapshot({ completed: [[TEAM_2, A, NOW - 1]] });
    expect(decideUndo(s, TEAM_1, A, NOW)).toEqual({ kind: "noop" });
  });

  it("the final task can't be undone, locked: 409 final_not_undoable", () => {
    expectErrorDecision(decideUndo(makeSnapshot(), TEAM_1, FINAL_ID, NOW), 409, "final_not_undoable");
  });

  it("the final task can't be undone, unlocked: 409 final_not_undoable", () => {
    const s = makeSnapshot({ completed: allNonFinal(TEAM_1) });
    expectErrorDecision(decideUndo(s, TEAM_1, FINAL_ID, NOW), 409, "final_not_undoable");
  });
});
