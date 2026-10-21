// SPEC.md §5 Rolling: countPerGame distinct active tasks per category, category by category
// in order, final category last; text copied. Selection algorithm per the approved M3 plan
// (partial Fisher-Yates over active tasks sorted by id).
import { describe, expect, it } from "vitest";
import { rollTasks } from "../src/worker/game/roll";
import type { CatalogCategory, CatalogTask } from "../src/worker/game/types";
import { cryptoRandomInt } from "../src/worker/random";
import { seqRandom } from "./helpers/game";

const cat = (
  id: string,
  sortOrder: number,
  countPerGame: number,
  extra: Partial<CatalogCategory> = {},
): CatalogCategory => ({ id, name: `Name ${id}`, sortOrder, countPerGame, isFinal: false, active: true, ...extra });

const task = (id: string, categoryId: string, active = true): CatalogTask => ({ id, categoryId, text: `Text ${id}`, active });

// The final category has the LOWEST sortOrder: it must still come last.
// Categories and tasks are deliberately given out of order.
const CATEGORIES: CatalogCategory[] = [
  cat("b", 2, 1),
  cat("z", 0, 1, { isFinal: true }),
  cat("off", 3, 1, { active: false }),
  cat("a", 1, 2),
];

const TASKS: CatalogTask[] = [
  task("a-3", "a"),
  task("z-2", "z"),
  task("a-1", "a"),
  task("a-x", "a", false),
  task("b-2", "b"),
  task("off-1", "off"),
  task("a-2", "a"),
  task("b-1", "b"),
  task("z-1", "z"),
];

function expectFailure(
  r: ReturnType<typeof rollTasks>,
  categoryName: string | null,
): void {
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.categoryName).toBe(categoryName);
    expect(typeof r.message).toBe("string");
    expect(r.message.length).toBeGreaterThan(0);
  }
}

describe("§5 rollTasks: deterministic selection", () => {
  it("picks exactly the scripted tasks (partial Fisher-Yates over ids sorted ascending)", () => {
    // a: [a-1,a-2,a-3]; i=0 j=0+2 -> [a-3,a-2,a-1]; i=1 j=1+0 -> picks a-3, a-2
    // b: [b-1,b-2]; j=1 -> b-2
    // z: [z-1,z-2]; j=0 -> z-1
    const rand = seqRandom([2, 0, 1, 0]);
    const r = rollTasks(CATEGORIES, TASKS, rand);
    expect(r).toEqual({
      ok: true,
      tasks: [
        { catalogTaskId: "a-3", categoryId: "a", text: "Text a-3", sortOrder: 1, isFinal: false },
        { catalogTaskId: "a-2", categoryId: "a", text: "Text a-2", sortOrder: 2, isFinal: false },
        { catalogTaskId: "b-2", categoryId: "b", text: "Text b-2", sortOrder: 3, isFinal: false },
        { catalogTaskId: "z-1", categoryId: "z", text: "Text z-1", sortOrder: 4, isFinal: true },
      ],
    });
    // One call per pick, with maxExclusive n - i, category by category, final last.
    expect(rand.calls).toEqual([3, 2, 2, 2]);
    expect(rand.remaining()).toBe(0);
  });

  it("all-zero script picks the lowest ids", () => {
    const r = rollTasks(CATEGORIES, TASKS, seqRandom([0, 0, 0, 0]));
    expect(r.ok && r.tasks.map((t) => t.catalogTaskId)).toEqual(["a-1", "a-2", "b-1", "z-1"]);
  });

  it("a second swap moves a later task forward", () => {
    // a: i=0 j=0 -> [a-1,a-2,a-3]; i=1 j=1+1 -> [a-1,a-3,a-2] -> picks a-1, a-3
    const r = rollTasks(CATEGORIES, TASKS, seqRandom([0, 1, 0, 1]));
    expect(r.ok && r.tasks.map((t) => t.catalogTaskId)).toEqual(["a-1", "a-3", "b-1", "z-2"]);
  });

  it("calls rand(1) when a category takes all of its tasks", () => {
    const rand = seqRandom([1, 0, 0]);
    const r = rollTasks([cat("a", 1, 2), cat("z", 2, 1, { isFinal: true })], [task("a-2", "a"), task("a-1", "a"), task("z-1", "z")], rand);
    expect(rand.calls).toEqual([2, 1, 1]);
    expect(r.ok && r.tasks.map((t) => t.catalogTaskId)).toEqual(["a-2", "a-1", "z-1"]);
  });

  it("copies text and gives sortOrder 1..N across the whole list", () => {
    const r = rollTasks(CATEGORIES, TASKS, seqRandom([1, 1, 0, 1]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tasks.map((t) => t.sortOrder)).toEqual([1, 2, 3, 4]);
    for (const t of r.tasks) expect(t.text).toBe(`Text ${t.catalogTaskId}`);
  });
});

describe("§5 rollTasks: category order and the final category", () => {
  it("orders non-final categories by ascending sortOrder and puts the final last even with the lowest sortOrder", () => {
    const r = rollTasks(CATEGORIES, TASKS, seqRandom([0, 0, 0, 0]));
    expect(r.ok && r.tasks.map((t) => [t.categoryId, t.isFinal])).toEqual([
      ["a", false],
      ["a", false],
      ["b", false],
      ["z", true],
    ]);
  });

  it("puts the final last when its sortOrder is in the middle", () => {
    const cats = [cat("c", 3, 1), cat("f", 2, 1, { isFinal: true }), cat("a", 1, 1)];
    const tasks = [task("c-1", "c"), task("f-1", "f"), task("a-1", "a")];
    const r = rollTasks(cats, tasks, seqRandom([0, 0, 0]));
    expect(r.ok && r.tasks.map((t) => t.categoryId)).toEqual(["a", "c", "f"]);
  });

  it("exactly one task is final", () => {
    const r = rollTasks(CATEGORIES, TASKS, seqRandom([0, 0, 0, 0]));
    expect(r.ok && r.tasks.filter((t) => t.isFinal)).toHaveLength(1);
  });

  it("works with only a final category", () => {
    const r = rollTasks([cat("z", 1, 1, { isFinal: true })], [task("z-1", "z")], seqRandom([0]));
    expect(r).toEqual({
      ok: true,
      tasks: [{ catalogTaskId: "z-1", categoryId: "z", text: "Text z-1", sortOrder: 1, isFinal: true }],
    });
  });

  it("fails with categoryName null when there is no final category", () => {
    expectFailure(rollTasks([cat("a", 1, 1)], [task("a-1", "a")], seqRandom([0, 0])), null);
  });

  it("fails with categoryName null when there are two active final categories", () => {
    const cats = [cat("a", 1, 1), cat("y", 2, 1, { isFinal: true }), cat("z", 3, 1, { isFinal: true })];
    const tasks = [task("a-1", "a"), task("y-1", "y"), task("z-1", "z")];
    expectFailure(rollTasks(cats, tasks, seqRandom([0, 0, 0, 0])), null);
  });

  it("fails with categoryName null when the final category's countPerGame is not 1", () => {
    const cats = [cat("a", 1, 1), cat("z", 2, 2, { isFinal: true })];
    const tasks = [task("a-1", "a"), task("z-1", "z"), task("z-2", "z")];
    expectFailure(rollTasks(cats, tasks, seqRandom([0, 0, 0, 0])), null);
  });

  it("fails with categoryName null when the only final category is inactive", () => {
    const cats = [cat("a", 1, 1), cat("z", 2, 1, { isFinal: true, active: false })];
    const tasks = [task("a-1", "a"), task("z-1", "z")];
    expectFailure(rollTasks(cats, tasks, seqRandom([0, 0, 0])), null);
  });

  it("ignores an inactive second final category", () => {
    const cats = [cat("a", 1, 1), cat("y", 2, 1, { isFinal: true, active: false }), cat("z", 3, 1, { isFinal: true })];
    const tasks = [task("a-1", "a"), task("y-1", "y"), task("z-1", "z")];
    const r = rollTasks(cats, tasks, seqRandom([0, 0]));
    expect(r.ok && r.tasks.map((t) => t.catalogTaskId)).toEqual(["a-1", "z-1"]);
  });
});

describe("§5 rollTasks: active tasks and categories only", () => {
  it("skips an inactive task when sorting and picking (a-x is never in the candidate array)", () => {
    // With a-x active it would sort last in a; rand(3) would be rand(4).
    const rand = seqRandom([2, 1, 0, 0]);
    const r = rollTasks(CATEGORIES, TASKS, rand);
    expect(rand.calls[0]).toBe(3);
    expect(r.ok && r.tasks.map((t) => t.catalogTaskId)).not.toContain("a-x");
  });

  it("skips an inactive category entirely (no rand call, no tasks)", () => {
    const rand = seqRandom([0, 0, 0, 0]);
    const r = rollTasks(CATEGORIES, TASKS, rand);
    expect(rand.calls).toEqual([3, 2, 2, 2]);
    expect(r.ok && r.tasks.some((t) => t.categoryId === "off")).toBe(false);
  });

  it("an inactive category with no tasks doesn't fail the roll", () => {
    const cats = [cat("a", 1, 1), cat("empty", 2, 3, { active: false }), cat("z", 3, 1, { isFinal: true })];
    const r = rollTasks(cats, [task("a-1", "a"), task("z-1", "z")], seqRandom([0, 0]));
    expect(r.ok).toBe(true);
  });

  it("ignores tasks whose category is not in the list", () => {
    const cats = [cat("a", 1, 1), cat("z", 2, 1, { isFinal: true })];
    const r = rollTasks(cats, [task("a-1", "a"), task("ghost-1", "ghost"), task("z-1", "z")], seqRandom([0, 0]));
    expect(r.ok && r.tasks.map((t) => t.catalogTaskId)).toEqual(["a-1", "z-1"]);
  });
});

describe("§5 rollTasks: short categories", () => {
  it("fails with the category's name when it has fewer active tasks than countPerGame", () => {
    const cats = [cat("a", 1, 2, { name: "Tough Drink" }), cat("z", 2, 1, { isFinal: true })];
    const tasks = [task("a-1", "a"), task("a-2", "a", false), task("z-1", "z")];
    expectFailure(rollTasks(cats, tasks, (max) => max - 1), "Tough Drink");
  });

  it("fails with the final category's name when it has no active tasks", () => {
    const cats = [cat("a", 1, 1), cat("z", 2, 1, { isFinal: true, name: "Final Puzzle" })];
    const tasks = [task("a-1", "a"), task("z-1", "z", false)];
    expectFailure(rollTasks(cats, tasks, () => 0), "Final Puzzle");
  });

  it("fails on a non-final category with zero tasks", () => {
    const cats = [cat("a", 1, 1, { name: "Empty One" }), cat("z", 2, 1, { isFinal: true })];
    expectFailure(rollTasks(cats, [task("z-1", "z")], () => 0), "Empty One");
  });
});

describe("§5 rollTasks with real crypto randomness", () => {
  it("over 200 runs: always valid, distinct picks, and every eligible task appears", () => {
    const seen = new Set<string>();
    for (let run = 0; run < 200; run++) {
      const r = rollTasks(CATEGORIES, TASKS, cryptoRandomInt);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const ids = r.tasks.map((t) => t.catalogTaskId);
      expect(ids).toHaveLength(4);
      expect(new Set(ids).size).toBe(4);
      expect(r.tasks.map((t) => t.categoryId)).toEqual(["a", "a", "b", "z"]);
      for (const id of ids) seen.add(id);
    }
    expect([...seen].sort()).toEqual(["a-1", "a-2", "a-3", "b-1", "b-2", "z-1", "z-2"]);
  });
});
