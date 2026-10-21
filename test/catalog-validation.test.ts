// SPEC.md §7 catalog validation, plus the structural rules Bob approved for M2.
// Error contract: every error is "<path>: <message>". Assertions check the path
// exactly and the message loosely (keyword regex), never full sentences.
import { describe, expect, it } from "vitest";
import realCatalog from "../catalog/catalog.json";
import { KEBAB_ID, parseCatalog, validateCatalog } from "../scripts/lib/catalog.mjs";

type Obj = Record<string, unknown>;
type Fixture = { categories: Obj[]; tasks: Obj[]; [key: string]: unknown };

/** A small valid catalog with fake data. `beta` needs exactly its two active tasks. */
const BASE: Fixture = {
  categories: [
    { id: "alpha", name: "Alpha", order: 1, countPerGame: 1 },
    { id: "beta", name: "Beta Things", order: 2, countPerGame: 2, final: false },
    { id: "finale", name: "Finale", order: 3, countPerGame: 1, final: true },
  ],
  tasks: [
    { id: "alpha-1", category: "alpha", text: "Alpha one" },
    { id: "beta-1", category: "beta", text: "Beta one" },
    { id: "beta-2", category: "beta", text: "Beta two", active: true },
    { id: "finale-1", category: "finale", text: "Finale one" },
    { id: "finale-2", category: "finale", text: "Finale two (retired)", active: false },
  ],
};

function variant(change: (c: Fixture) => void): Fixture {
  const c = structuredClone(BASE);
  change(c);
  return c;
}

function cat(c: Fixture, i: number): Obj {
  const v = c.categories[i];
  if (!v) throw new Error(`fixture has no categories[${i}]`);
  return v;
}

function task(c: Fixture, i: number): Obj {
  const v = c.tasks[i];
  if (!v) throw new Error(`fixture has no tasks[${i}]`);
  return v;
}

function pathOf(error: string): string | null {
  const i = error.indexOf(": ");
  return i === -1 ? null : error.slice(0, i);
}

/** Asserts some error has one of `paths` as its path and a message matching `keyword`. */
function expectErrorAt(errors: string[], paths: string | string[], keyword: RegExp) {
  const want = Array.isArray(paths) ? paths : [paths];
  const hit = errors.some((e) => {
    const p = pathOf(e);
    return p !== null && want.includes(p) && keyword.test(e.slice(p.length + 2));
  });
  expect(hit, `expected an error at ${want.join(" or ")} matching ${keyword}; got ${JSON.stringify(errors)}`).toBe(
    true,
  );
}

/** Paths for fixtures that keep a valid top level look like categories[2].id. */
const PATH_FORMAT = /^(categories|tasks)(\[\d+\])?(\.[A-Za-z]+)?$/;

function expectWellFormed(errors: string[]) {
  expect(Array.isArray(errors)).toBe(true);
  expect(errors.length).toBeGreaterThan(0);
  for (const e of errors) {
    expect(typeof e).toBe("string");
    const p = pathOf(e);
    expect(p, `error without "<path>: " prefix: ${JSON.stringify(e)}`).not.toBeNull();
    expect(p, `unexpected path in ${JSON.stringify(e)}`).toMatch(PATH_FORMAT);
    expect(e.slice((p as string).length + 2).trim(), `empty message in ${JSON.stringify(e)}`).not.toBe("");
  }
}

function errorsFor(c: unknown): string[] {
  const errors = validateCatalog(c);
  return errors;
}

describe("§7 validation: the real catalog/catalog.json", () => {
  it("has zero errors", () => {
    expect(validateCatalog(realCatalog)).toEqual([]);
  });

  it("matches the content in SPEC.md §7 exactly", () => {
    expect(realCatalog).toEqual({
      categories: [
        { id: "beer", name: "Beer", order: 1, countPerGame: 1 },
        { id: "tough-drink", name: "Tough Drink", order: 2, countPerGame: 2 },
        { id: "food", name: "Food Challenge", order: 3, countPerGame: 1 },
        { id: "cognitive", name: "Cognitive", order: 4, countPerGame: 1 },
        { id: "puzzle", name: "Final Puzzle", order: 5, countPerGame: 1, final: true },
      ],
      tasks: [
        { id: "beer-case-24", category: "beer", text: "Finish a 24-can case" },
        { id: "four-loko", category: "tough-drink", text: "Four Loko" },
        { id: "natty-daddy", category: "tough-drink", text: "Natty Daddy" },
        { id: "syrup-challenge", category: "food", text: "Syrup challenge (TBD)" },
        { id: "banana-challenge", category: "food", text: "Banana challenge (TBD)" },
        { id: "word-search", category: "cognitive", text: "Complete a word search" },
        { id: "puzzle-250", category: "puzzle", text: "250-piece puzzle" },
        { id: "puzzle-500", category: "puzzle", text: "500-piece puzzle" },
      ],
    });
  });

  it("passes parseCatalog and comes back unchanged", () => {
    expect(parseCatalog(realCatalog)).toEqual(realCatalog);
  });
});

describe("§7 validation: valid fixtures", () => {
  it("the baseline fixture has zero errors", () => {
    expect(validateCatalog(BASE)).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = structuredClone(BASE);
    validateCatalog(input);
    expect(input).toEqual(BASE);
  });

  it("allows a task id equal to a category id (uniqueness is per collection)", () => {
    const c = variant((c) => c.tasks.push({ id: "alpha", category: "alpha", text: "Same id as its category" }));
    expect(validateCatalog(c)).toEqual([]);
  });

  it("allows final: false and active: true explicitly", () => {
    const c = variant((c) => {
      cat(c, 0).final = false;
      task(c, 0).active = true;
    });
    expect(validateCatalog(c)).toEqual([]);
  });

  it("allows quotes, semicolons, backslashes and emoji in name and text", () => {
    const c = variant((c) => {
      cat(c, 0).name = `Bob's "big" day; \\ 🍺`;
      task(c, 0).text = `Bob's "big" day; DROP TABLE games; -- \\ 🍺`;
    });
    expect(validateCatalog(c)).toEqual([]);
  });

  it("allows name and text of exactly 200 characters", () => {
    const c = variant((c) => {
      cat(c, 0).name = "n".repeat(200);
      task(c, 0).text = "t".repeat(200);
    });
    expect(validateCatalog(c)).toEqual([]);
  });

  it("does not require categories or tasks to be listed in order", () => {
    const c = variant((c) => {
      c.categories.reverse();
      c.tasks.reverse();
    });
    expect(validateCatalog(c)).toEqual([]);
  });
});

describe("§7 validation: KEBAB_ID", () => {
  it("is the approved pattern", () => {
    expect(KEBAB_ID).toBeInstanceOf(RegExp);
    expect(KEBAB_ID.source).toBe("^[a-z0-9]+(?:-[a-z0-9]+)*$");
  });

  it.each(["beer", "beer-case-24", "250-piece", "a", "x1-y2-z3"])("accepts %j", (id) => {
    expect(KEBAB_ID.test(id)).toBe(true);
  });

  it.each(["Beer", "beer_case", "-beer", "beer-", "beer--case", "", "beer case", " beer", "bëer"])(
    "rejects %j",
    (id) => {
      expect(KEBAB_ID.test(id)).toBe(false);
    },
  );
});

describe("§7 validation rule 1: ids are kebab-case", () => {
  const bad = ["Beer", "beer_case", "-beer", "beer-", "beer--case", "beer case", "bëer"];

  it.each(bad)("rejects category id %j at categories[0].id", (id) => {
    const errors = errorsFor(variant((c) => (cat(c, 0).id = id)));
    expectWellFormed(errors);
    expectErrorAt(errors, "categories[0].id", /kebab/i);
  });

  it.each(bad)("rejects task id %j at tasks[1].id", (id) => {
    const errors = errorsFor(variant((c) => (task(c, 1).id = id)));
    expectWellFormed(errors);
    expectErrorAt(errors, "tasks[1].id", /kebab/i);
  });

  it("rejects an empty category id", () => {
    const errors = errorsFor(variant((c) => (cat(c, 0).id = "")));
    expectWellFormed(errors);
    expectErrorAt(errors, "categories[0].id", /kebab|empty|string|required/i);
  });

  it("rejects an empty task id", () => {
    const errors = errorsFor(variant((c) => (task(c, 0).id = "")));
    expectWellFormed(errors);
    expectErrorAt(errors, "tasks[0].id", /kebab|empty|string|required/i);
  });

  it("rejects a numeric category id", () => {
    const errors = errorsFor(variant((c) => (cat(c, 0).id = 42)));
    expectWellFormed(errors);
    expectErrorAt(errors, "categories[0].id", /kebab|string/i);
  });

  it("rejects a numeric task id", () => {
    const errors = errorsFor(variant((c) => (task(c, 0).id = 42)));
    expectWellFormed(errors);
    expectErrorAt(errors, "tasks[0].id", /kebab|string/i);
  });
});

describe("§7 validation rule 1: ids are unique within categories and within tasks", () => {
  it("rejects a duplicate category id at the later occurrence", () => {
    const errors = errorsFor(
      variant((c) => c.categories.push({ id: "alpha", name: "Alpha again", order: 4, countPerGame: 1 })),
    );
    expectWellFormed(errors);
    expectErrorAt(errors, ["categories[3].id", "categories[3]"], /duplicate/i);
  });

  it("rejects a duplicate task id at the later occurrence", () => {
    const errors = errorsFor(variant((c) => c.tasks.push({ id: "beta-1", category: "alpha", text: "Copy" })));
    expectWellFormed(errors);
    expectErrorAt(errors, ["tasks[5].id", "tasks[5]"], /duplicate/i);
  });
});

describe("§7 validation rule 2: every task's category exists", () => {
  it("rejects a task whose category is unknown", () => {
    const errors = errorsFor(
      variant((c) => c.tasks.push({ id: "stray", category: "nope", text: "Points nowhere" })),
    );
    expectWellFormed(errors);
    expectErrorAt(errors, "tasks[5].category", /unknown|exist|not found|no such/i);
  });

  it("rejects an inactive task whose category is unknown too", () => {
    const errors = errorsFor(
      variant((c) => c.tasks.push({ id: "stray", category: "nope", text: "Points nowhere", active: false })),
    );
    expectWellFormed(errors);
    expectErrorAt(errors, "tasks[5].category", /unknown|exist|not found|no such/i);
  });

  it("is case-sensitive about category ids", () => {
    const errors = errorsFor(variant((c) => (task(c, 0).category = "Alpha")));
    expectWellFormed(errors);
    expectErrorAt(errors, "tasks[0].category", /unknown|exist|not found|no such/i);
  });
});

describe("§7 validation rule 3: exactly one final category, with countPerGame 1", () => {
  it("rejects a catalog with no final category", () => {
    const errors = errorsFor(variant((c) => delete cat(c, 2).final));
    expectWellFormed(errors);
    expectErrorAt(errors, "categories", /final/i);
  });

  it("rejects a catalog whose only final flag is false", () => {
    const errors = errorsFor(variant((c) => (cat(c, 2).final = false)));
    expectWellFormed(errors);
    expectErrorAt(errors, "categories", /final/i);
  });

  it("rejects two final categories", () => {
    const errors = errorsFor(variant((c) => (cat(c, 0).final = true)));
    expectWellFormed(errors);
    expectErrorAt(errors, "categories", /final/i);
  });

  it("rejects a final category with countPerGame 2, even with enough tasks", () => {
    const errors = errorsFor(
      variant((c) => {
        cat(c, 2).countPerGame = 2;
        task(c, 4).active = true;
      }),
    );
    expectWellFormed(errors);
    expectErrorAt(errors, ["categories[2]", "categories[2].countPerGame"], /final/i);
  });
});

describe("§7 validation rule 4: countPerGame is an integer of at least 1", () => {
  it.each<[string, unknown]>([
    ["0", 0],
    ["-1", -1],
    ["1.5", 1.5],
    ['the string "1"', "1"],
    ["null", null],
    ["NaN", Number.NaN],
  ])("rejects countPerGame %s", (_name, value) => {
    const errors = errorsFor(variant((c) => (cat(c, 0).countPerGame = value)));
    expectWellFormed(errors);
    expectErrorAt(errors, "categories[0].countPerGame", /integer|least|number|positive|>=|≥/i);
  });

  it("rejects a missing countPerGame", () => {
    const errors = errorsFor(variant((c) => delete cat(c, 0).countPerGame));
    expectWellFormed(errors);
    expectErrorAt(errors, "categories[0].countPerGame", /required|missing|integer|number/i);
  });
});

describe("§7 validation rule 5: each category has at least countPerGame active tasks", () => {
  it("rejects a category with fewer tasks than countPerGame", () => {
    const errors = errorsFor(variant((c) => c.tasks.splice(2, 1)));
    expectWellFormed(errors);
    expectErrorAt(errors, "categories[1]", /task/i);
  });

  it("does not count a task marked active: false", () => {
    const errors = errorsFor(variant((c) => (task(c, 2).active = false)));
    expectWellFormed(errors);
    expectErrorAt(errors, "categories[1]", /task/i);
  });

  it("rejects a category with no tasks at all", () => {
    const errors = errorsFor(
      variant((c) => c.categories.push({ id: "empty-cat", name: "Empty", order: 4, countPerGame: 1 })),
    );
    expectWellFormed(errors);
    expectErrorAt(errors, "categories[3]", /task/i);
  });

  it("rejects raising countPerGame above the active task count", () => {
    const errors = errorsFor(variant((c) => (cat(c, 0).countPerGame = 2)));
    expectWellFormed(errors);
    expectErrorAt(errors, "categories[0]", /task/i);
  });

  it("rejects a final category whose only active task is retired", () => {
    const errors = errorsFor(variant((c) => (task(c, 3).active = false)));
    expectWellFormed(errors);
    expectErrorAt(errors, "categories[2]", /task/i);
  });
});

describe("§7 validation structural: top level", () => {
  it.each<[string, unknown]>([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "catalog"],
    ["an array", []],
    ["true", true],
  ])("returns errors (and does not throw) for %s", (_name, input) => {
    const errors = validateCatalog(input);
    expect(Array.isArray(errors)).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect(typeof e).toBe("string");
  });

  it.each<[string, (c: Fixture) => void]>([
    ["missing", (c) => delete (c as Obj).categories],
    ["null", (c) => ((c as Obj).categories = null)],
    ["an object", (c) => ((c as Obj).categories = {})],
    ["a string", (c) => ((c as Obj).categories = "beer")],
    ["empty", (c) => (c.categories = [])],
  ])("rejects categories that is %s", (_name, change) => {
    const errors = errorsFor(variant(change));
    expectWellFormed(errors);
    expectErrorAt(errors, "categories", /./);
  });

  it.each<[string, (c: Fixture) => void]>([
    ["missing", (c) => delete (c as Obj).tasks],
    ["null", (c) => ((c as Obj).tasks = null)],
    ["an object", (c) => ((c as Obj).tasks = {})],
    ["a string", (c) => ((c as Obj).tasks = "beer")],
    ["empty", (c) => (c.tasks = [])],
  ])("rejects tasks that is %s", (_name, change) => {
    const errors = errorsFor(variant(change));
    expectWellFormed(errors);
    expectErrorAt(errors, "tasks", /./);
  });

  it("rejects an unknown top-level key", () => {
    const errors = errorsFor(variant((c) => (c.extra = true)));
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some((e) => /unknown/i.test(e) && e.includes("extra")),
      `expected an unknown-key error naming "extra"; got ${JSON.stringify(errors)}`,
    ).toBe(true);
  });
});

describe("§7 validation structural: entries are objects", () => {
  it.each<[string, unknown]>([
    ["null", null],
    ["a string", "alpha"],
    ["an array", []],
    ["a number", 1],
  ])("rejects a category that is %s", (_name, value) => {
    const errors = errorsFor(variant((c) => (c.categories[0] = value as Obj)));
    expectWellFormed(errors);
    expectErrorAt(errors, "categories[0]", /object/i);
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["a string", "alpha-1"],
    ["an array", []],
    ["a number", 1],
  ])("rejects a task that is %s", (_name, value) => {
    const errors = errorsFor(variant((c) => (c.tasks[0] = value as Obj)));
    expectWellFormed(errors);
    expectErrorAt(errors, "tasks[0]", /object/i);
  });
});

describe("§7 validation structural: required fields are non-empty strings", () => {
  const MISSING_OR_BAD = /required|missing|string|empty/i;

  it.each<[string, string, unknown]>([
    ["missing", "id", undefined],
    ["missing", "name", undefined],
    ["empty", "name", ""],
    ["a number", "name", 7],
    ["null", "name", null],
    ["null", "id", null],
  ])("rejects a category %s %s", (_name, field, value) => {
    const errors = errorsFor(
      variant((c) => {
        if (value === undefined) delete cat(c, 0)[field];
        else cat(c, 0)[field] = value;
      }),
    );
    expectWellFormed(errors);
    expectErrorAt(errors, `categories[0].${field}`, value === undefined ? MISSING_OR_BAD : /./);
  });

  it.each<[string, string, unknown]>([
    ["missing", "id", undefined],
    ["missing", "category", undefined],
    ["missing", "text", undefined],
    ["empty", "text", ""],
    ["empty", "category", ""],
    ["a number", "text", 7],
    ["a number", "category", 1],
    ["null", "text", null],
  ])("rejects a task %s %s", (_name, field, value) => {
    const errors = errorsFor(
      variant((c) => {
        if (value === undefined) delete task(c, 0)[field];
        else task(c, 0)[field] = value;
      }),
    );
    expectWellFormed(errors);
    expectErrorAt(errors, `tasks[0].${field}`, value === undefined ? MISSING_OR_BAD : /./);
  });
});

describe("§7 validation structural: order is a unique integer", () => {
  it.each<[string, unknown]>([
    ["missing", undefined],
    ["1.5", 1.5],
    ['the string "1"', "1"],
    ["null", null],
  ])("rejects order %s", (_name, value) => {
    const errors = errorsFor(
      variant((c) => {
        if (value === undefined) delete cat(c, 0).order;
        else cat(c, 0).order = value;
      }),
    );
    expectWellFormed(errors);
    expectErrorAt(errors, "categories[0].order", /integer|required|missing|number/i);
  });

  it("rejects a duplicate order at the later occurrence", () => {
    const errors = errorsFor(variant((c) => (cat(c, 1).order = 1)));
    expectWellFormed(errors);
    expectErrorAt(errors, ["categories[1].order", "categories[1]"], /duplicate|unique/i);
  });
});

describe("§7 validation structural: final and active are booleans when present", () => {
  it.each<[string, unknown]>([
    ['the string "true"', "true"],
    ["1", 1],
  ])("rejects final as %s", (_name, value) => {
    const errors = errorsFor(variant((c) => (cat(c, 2).final = value)));
    expectWellFormed(errors);
    expectErrorAt(errors, "categories[2].final", /boolean/i);
  });

  it.each<[string, unknown]>([
    ['the string "false"', "false"],
    ["0", 0],
  ])("rejects active as %s", (_name, value) => {
    const errors = errorsFor(variant((c) => (task(c, 0).active = value)));
    expectWellFormed(errors);
    expectErrorAt(errors, "tasks[0].active", /boolean/i);
  });
});

describe("§7 validation structural: unknown keys are rejected at every level", () => {
  it("rejects an active key on a category (categories have no active flag)", () => {
    const errors = errorsFor(variant((c) => (cat(c, 0).active = true)));
    expectWellFormed(errors);
    expectErrorAt(errors, ["categories[0]", "categories[0].active"], /unknown/i);
  });

  it("rejects the typo key countPergame on a category", () => {
    const errors = errorsFor(
      variant((c) => {
        const c0 = cat(c, 0);
        c0.countPergame = c0.countPerGame;
        delete c0.countPerGame;
      }),
    );
    expectWellFormed(errors);
    expectErrorAt(errors, ["categories[0]", "categories[0].countPergame"], /unknown/i);
  });

  it("rejects an unknown key on a task", () => {
    const errors = errorsFor(variant((c) => (task(c, 0).notes = "extra")));
    expectWellFormed(errors);
    expectErrorAt(errors, ["tasks[0]", "tasks[0].notes"], /unknown/i);
  });

  it("rejects a task key spelled like the category field name (categoryId)", () => {
    const errors = errorsFor(
      variant((c) => {
        const t0 = task(c, 0);
        t0.categoryId = t0.category;
        delete t0.category;
      }),
    );
    expectWellFormed(errors);
    expectErrorAt(errors, ["tasks[0]", "tasks[0].categoryId"], /unknown/i);
  });
});

describe("§7 validation structural: name and text are single-line, no control characters, at most 200 chars", () => {
  const CONTROL = /control|newline|line break|character/i;
  const controls: Array<[string, string]> = [
    ["a newline", "\n"],
    ["a carriage return", "\r"],
    ["a tab", "\t"],
    ["a NUL", "\u0000"],
    ["an escape", "\u001b"],
    ["a DEL", "\u007f"],
    ["a C1 next-line", "\u0085"],
  ];

  it.each(controls)("rejects %s in a category name", (_name, ch) => {
    const errors = errorsFor(variant((c) => (cat(c, 0).name = `Al${ch}pha`)));
    expectWellFormed(errors);
    expectErrorAt(errors, "categories[0].name", CONTROL);
  });

  it.each(controls)("rejects %s in task text", (_name, ch) => {
    const errors = errorsFor(variant((c) => (task(c, 0).text = `Alpha${ch}one`)));
    expectWellFormed(errors);
    expectErrorAt(errors, "tasks[0].text", CONTROL);
  });

  it("rejects a trailing newline in task text", () => {
    const errors = errorsFor(variant((c) => (task(c, 0).text = "Alpha one\n")));
    expectWellFormed(errors);
    expectErrorAt(errors, "tasks[0].text", CONTROL);
  });

  it("rejects a category name of 201 characters", () => {
    const errors = errorsFor(variant((c) => (cat(c, 0).name = "n".repeat(201))));
    expectWellFormed(errors);
    expectErrorAt(errors, "categories[0].name", /200|long|length|characters/i);
  });

  it("rejects task text of 201 characters", () => {
    const errors = errorsFor(variant((c) => (task(c, 0).text = "t".repeat(201))));
    expectWellFormed(errors);
    expectErrorAt(errors, "tasks[0].text", /200|long|length|characters/i);
  });
});

describe("§7 validation: reports every error, not just the first", () => {
  it("lists one error per problem across categories and tasks", () => {
    const c = variant((c) => {
      cat(c, 0).id = "Alpha_Bad";
      task(c, 1).text = "two\nlines";
      cat(c, 1).order = 1.5;
    });
    const errors = errorsFor(c);
    expectWellFormed(errors);
    expectErrorAt(errors, "categories[0].id", /kebab/i);
    expectErrorAt(errors, "tasks[1].text", /control|newline|line break|character/i);
    expectErrorAt(errors, "categories[1].order", /integer|number/i);
  });

  it("returns the same errors for the same input (deterministic)", () => {
    const c = variant((c) => {
      cat(c, 0).final = true;
      task(c, 0).category = "nope";
    });
    expect(validateCatalog(c)).toEqual(validateCatalog(structuredClone(c)));
  });
});

describe("§7 parseCatalog", () => {
  it("returns the catalog when it is valid", () => {
    const input = structuredClone(BASE);
    expect(parseCatalog(input)).toEqual(BASE);
  });

  it("throws an Error whose message lists every validation error", () => {
    const c = variant((c) => {
      cat(c, 0).id = "Bad_Id";
      task(c, 2).active = false;
      cat(c, 0).final = true;
    });
    const errors = validateCatalog(c);
    expect(errors.length).toBeGreaterThanOrEqual(3);

    let thrown: unknown;
    try {
      parseCatalog(c);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    for (const e of errors) expect(message).toContain(e);
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["an empty object", {}],
    ["an array", []],
  ])("throws for %s", (_name, input) => {
    expect(() => parseCatalog(input)).toThrow(Error);
  });
});
