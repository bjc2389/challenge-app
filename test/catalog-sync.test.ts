// SPEC.md §7 catalog sync: generated SQL upserts every category and task, marks
// anything missing from the file inactive, and never deletes. Runs against env.DB.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import realCatalog from "../catalog/catalog.json";
import { catalogToSql, catalogToStatements, parseCatalog, sqlString } from "../scripts/lib/catalog.mjs";
import {
  execableSql,
  insertGame,
  insertGameTask,
  insertTeam,
  resetDb,
  snapshotCatalog,
  type Row,
} from "./helpers/db";

// The approved shapes from the M2 plan (scripts/lib/catalog.mjs documents the same types in JSDoc).
type Category = { id: string; name: string; order: number; countPerGame: number; final?: boolean };
type Task = { id: string; category: string; text: string; active?: boolean };
type Catalog = { categories: Category[]; tasks: Task[] };

function real(): Catalog {
  const parsed: Catalog = parseCatalog(structuredClone(realCatalog));
  return parsed;
}

/** Runs the generated sync SQL through D1 exactly as generated, minus the header comment line. */
async function sync(c: Catalog): Promise<void> {
  await env.DB.exec(execableSql(catalogToSql(c)));
}

function taskRow(rows: Row[], id: string): Row {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`no catalog_tasks row ${id}`);
  return row;
}

function categoryRow(rows: Row[], id: string): Row {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`no categories row ${id}`);
  return row;
}

async function tableExists(name: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
    .bind("table", name)
    .first();
  return row !== null;
}

const ESCAPE_TEXT = `Sam's "big" day; DROP TABLE games; -- \\ 🍺`;

beforeEach(async () => {
  await resetDb();
});

describe("§7 sync: first sync of the real catalog", () => {
  it("creates 5 categories with the right sort_order, count_per_game and is_final, all active", async () => {
    await sync(real());
    const rows = (
      await env.DB.prepare("SELECT * FROM categories ORDER BY sort_order").all()
    ).results;
    expect(rows).toEqual([
      { id: "beer", name: "Beer", sort_order: 1, count_per_game: 1, is_final: 0, active: 1 },
      { id: "tough-drink", name: "Tough Drink", sort_order: 2, count_per_game: 2, is_final: 0, active: 1 },
      { id: "food", name: "Food Challenge", sort_order: 3, count_per_game: 1, is_final: 0, active: 1 },
      { id: "cognitive", name: "Cognitive", sort_order: 4, count_per_game: 1, is_final: 0, active: 1 },
      { id: "puzzle", name: "Final Puzzle", sort_order: 5, count_per_game: 1, is_final: 1, active: 1 },
    ]);
  });

  it("creates 8 tasks with the right category and text, all active", async () => {
    await sync(real());
    const { tasks } = await snapshotCatalog();
    expect(tasks).toEqual(
      [
        { id: "banana-challenge", category_id: "food", text: "Banana challenge (TBD)", active: 1 },
        { id: "beer-case-24", category_id: "beer", text: "Finish a 24-can case", active: 1 },
        { id: "four-loko", category_id: "tough-drink", text: "Four Loko", active: 1 },
        { id: "natty-daddy", category_id: "tough-drink", text: "Natty Daddy", active: 1 },
        { id: "puzzle-250", category_id: "puzzle", text: "250-piece puzzle", active: 1 },
        { id: "puzzle-500", category_id: "puzzle", text: "500-piece puzzle", active: 1 },
        { id: "syrup-challenge", category_id: "food", text: "Syrup challenge (TBD)", active: 1 },
        { id: "word-search", category_id: "cognitive", text: "Complete a word search", active: 1 },
      ],
    );
  });
});

describe("§7 sync: idempotence", () => {
  it("running the same sync twice leaves identical full snapshots", async () => {
    await sync(real());
    const first = await snapshotCatalog();
    await sync(real());
    const second = await snapshotCatalog();
    expect(second).toEqual(first);
    expect(first.categories).toHaveLength(5);
    expect(first.tasks).toHaveLength(8);
  });

  it("a sync after a removal is also idempotent", async () => {
    await sync(real());
    const c = real();
    c.tasks = c.tasks.filter((t) => t.id !== "banana-challenge");
    await sync(c);
    const first = await snapshotCatalog();
    await sync(c);
    expect(await snapshotCatalog()).toEqual(first);
  });
});

describe("§7 sync: updates rows in place", () => {
  it("updates name, sort_order, count_per_game, is_final and task text without adding rows", async () => {
    await sync(real());
    const c = real();
    for (const cat of c.categories) {
      if (cat.id === "beer") {
        cat.name = "Beer (renamed)";
        cat.order = 10;
      }
      if (cat.id === "tough-drink") cat.countPerGame = 1;
      if (cat.id === "cognitive") cat.final = true;
      if (cat.id === "puzzle") delete cat.final;
    }
    for (const t of c.tasks) if (t.id === "four-loko") t.text = "Four Loko, updated";
    await sync(c);

    const { categories, tasks } = await snapshotCatalog();
    expect(categories).toHaveLength(5);
    expect(tasks).toHaveLength(8);
    expect(categoryRow(categories, "beer")).toMatchObject({ name: "Beer (renamed)", sort_order: 10, active: 1 });
    expect(categoryRow(categories, "tough-drink")).toMatchObject({ count_per_game: 1, active: 1 });
    expect(categoryRow(categories, "cognitive")).toMatchObject({ is_final: 1, active: 1 });
    expect(categoryRow(categories, "puzzle")).toMatchObject({ is_final: 0, active: 1 });
    expect(taskRow(tasks, "four-loko")).toEqual({
      id: "four-loko",
      category_id: "tough-drink",
      text: "Four Loko, updated",
      active: 1,
    });
  });

  it("moves a task to a different category", async () => {
    await sync(real());
    const c = real();
    for (const t of c.tasks) if (t.id === "banana-challenge") t.category = "cognitive";
    await sync(c);
    const { tasks } = await snapshotCatalog();
    expect(taskRow(tasks, "banana-challenge")).toMatchObject({ category_id: "cognitive", active: 1 });
  });

  it("adds a new category and a task in it in the same sync", async () => {
    await sync(real());
    const c = real();
    c.categories.push({ id: "bonus", name: "Bonus", order: 6, countPerGame: 1 });
    c.tasks.push({ id: "bonus-task", category: "bonus", text: "A bonus task" });
    await sync(c);
    const { categories, tasks } = await snapshotCatalog();
    expect(categoryRow(categories, "bonus")).toEqual({
      id: "bonus",
      name: "Bonus",
      sort_order: 6,
      count_per_game: 1,
      is_final: 0,
      active: 1,
    });
    expect(taskRow(tasks, "bonus-task")).toEqual({
      id: "bonus-task",
      category_id: "bonus",
      text: "A bonus task",
      active: 1,
    });
  });
});

describe("§7 sync: rows missing from the file are marked inactive, never deleted", () => {
  it("keeps a removed task with active = 0 and its last text", async () => {
    await sync(real());
    const c = real();
    c.tasks = c.tasks.filter((t) => t.id !== "banana-challenge");
    await sync(c);
    const { categories, tasks } = await snapshotCatalog();
    expect(tasks).toHaveLength(8);
    expect(taskRow(tasks, "banana-challenge")).toEqual({
      id: "banana-challenge",
      category_id: "food",
      text: "Banana challenge (TBD)",
      active: 0,
    });
    for (const t of tasks) if (t.id !== "banana-challenge") expect(t.active).toBe(1);
    for (const cat of categories) expect(cat.active).toBe(1);
  });

  it("keeps a removed category and its removed tasks with active = 0", async () => {
    await sync(real());
    const c = real();
    c.categories = c.categories.filter((cat) => cat.id !== "cognitive");
    c.tasks = c.tasks.filter((t) => t.category !== "cognitive");
    await sync(c);
    const { categories, tasks } = await snapshotCatalog();
    expect(categories).toHaveLength(5);
    expect(tasks).toHaveLength(8);
    expect(categoryRow(categories, "cognitive")).toMatchObject({ active: 0, name: "Cognitive" });
    expect(taskRow(tasks, "word-search")).toMatchObject({ active: 0, category_id: "cognitive" });
    expect(categories.filter((r) => r.active === 1)).toHaveLength(4);
    expect(tasks.filter((r) => r.active === 1)).toHaveLength(7);
  });

  it("reactivates a removed task and category when they come back", async () => {
    await sync(real());
    const c = real();
    c.categories = c.categories.filter((cat) => cat.id !== "cognitive");
    c.tasks = c.tasks.filter((t) => t.category !== "cognitive");
    await sync(c);
    await sync(real());
    const { categories, tasks } = await snapshotCatalog();
    expect(categoryRow(categories, "cognitive").active).toBe(1);
    expect(taskRow(tasks, "word-search").active).toBe(1);
  });

  it("writes active = 0 for a task marked active: false, and 1 again once the flag is removed", async () => {
    const c = real();
    for (const t of c.tasks) if (t.id === "syrup-challenge") t.active = false;
    await sync(c);
    expect(taskRow((await snapshotCatalog()).tasks, "syrup-challenge").active).toBe(0);

    await sync(real());
    expect(taskRow((await snapshotCatalog()).tasks, "syrup-challenge").active).toBe(1);
  });

  it("writes active = 1 for a task marked active: true", async () => {
    const c = real();
    for (const t of c.tasks) if (t.id === "syrup-challenge") t.active = true;
    await sync(c);
    expect(taskRow((await snapshotCatalog()).tasks, "syrup-challenge").active).toBe(1);
  });

  it("succeeds when a removed task is still referenced by a game_tasks row, which stays as it was", async () => {
    await sync(real());
    const gameId = await insertGame("ABCDE");
    await insertTeam(gameId, 1, "Team One");
    await insertTeam(gameId, 2, "Team Two");
    const gtId = await insertGameTask(
      gameId,
      { catalogTaskId: "banana-challenge", categoryId: "food", text: "Banana challenge (TBD)", isFinal: 0 },
      1,
    );

    const c = real();
    c.tasks = c.tasks.filter((t) => t.id !== "banana-challenge");
    await sync(c);

    const gt = await env.DB.prepare("SELECT * FROM game_tasks WHERE id = ?").bind(gtId).first();
    expect(gt).toMatchObject({
      game_id: gameId,
      catalog_task_id: "banana-challenge",
      category_id: "food",
      text: "Banana challenge (TBD)",
      sort_order: 1,
      is_final: 0,
    });
    expect(taskRow((await snapshotCatalog()).tasks, "banana-challenge").active).toBe(0);
  });

  it("succeeds when a removed category is still referenced by game_tasks", async () => {
    await sync(real());
    const gameId = await insertGame("FGHJK");
    await insertGameTask(
      gameId,
      { catalogTaskId: "word-search", categoryId: "cognitive", text: "Complete a word search", isFinal: 0 },
      1,
    );
    const c = real();
    c.categories = c.categories.filter((cat) => cat.id !== "cognitive");
    c.tasks = c.tasks.filter((t) => t.category !== "cognitive");
    await sync(c);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM game_tasks WHERE game_id = ?")
      .bind(gameId)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});

describe("§7 sync: escaping", () => {
  it("round-trips quotes, a semicolon, SQL keywords, a comment marker, a backslash and emoji exactly", async () => {
    const c = real();
    for (const t of c.tasks) if (t.id === "four-loko") t.text = ESCAPE_TEXT;
    for (const cat of c.categories) if (cat.id === "beer") cat.name = `Sam's "beer"; -- \\`;
    await sync(c);

    const { categories, tasks } = await snapshotCatalog();
    expect(taskRow(tasks, "four-loko").text).toBe(ESCAPE_TEXT);
    expect(categoryRow(categories, "beer").name).toBe(`Sam's "beer"; -- \\`);
    expect(tasks).toHaveLength(8);
    expect(await tableExists("games")).toBe(true);
  });

  it("keeps the escaped text on a single statement line", () => {
    const c = real();
    for (const t of c.tasks) if (t.id === "four-loko") t.text = ESCAPE_TEXT;
    const stmts: string[] = catalogToStatements(c);
    expect(stmts).toHaveLength(c.categories.length + c.tasks.length + 2);
    const line = stmts.find((s) => s.includes("'four-loko'"));
    expect(line).toBeDefined();
    expect(line).toContain(sqlString(ESCAPE_TEXT));
  });
});

describe("§7 sync: generated SQL shape", () => {
  it("contains no DELETE, DROP, BEGIN or COMMIT", () => {
    const sql = catalogToSql(real());
    expect(sql).not.toMatch(/\b(DELETE|DROP|BEGIN|COMMIT|TRUNCATE|ROLLBACK)\b/i);
  });

  it("is deterministic", () => {
    expect(catalogToSql(real())).toBe(catalogToSql(real()));
    expect(catalogToStatements(real())).toEqual(catalogToStatements(real()));
  });

  it("is a header comment line followed by exactly the statements, one per line", () => {
    const c = real();
    const sql = catalogToSql(c);
    const lines = sql.replace(/\n$/, "").split("\n");
    expect(lines[0]).toMatch(/^--/);
    expect(lines.slice(1)).toEqual(catalogToStatements(c));
  });

  it("has one statement per line, each ending in a semicolon", () => {
    const stmts: string[] = catalogToStatements(real());
    expect(stmts).toHaveLength(5 + 8 + 2);
    for (const s of stmts) {
      expect(s).not.toMatch(/[\r\n]/);
      expect(s.trimEnd()).toMatch(/;$/);
      // A single statement: the only semicolon is the last character.
      expect(s.trimEnd().slice(0, -1)).not.toContain(";");
    }
  });

  it("orders statements: categories in file order, tasks in file order, then the two deactivation UPDATEs", () => {
    const c = real();
    const stmts: string[] = catalogToStatements(c);
    c.categories.forEach((cat, i) => {
      const s = stmts[i] ?? "";
      expect(s).toMatch(/^INSERT INTO categories \(id, name, sort_order, count_per_game, is_final, active\) VALUES \(/);
      expect(s).toContain(sqlString(cat.id));
      expect(s).toMatch(/ON CONFLICT \(id\) DO UPDATE SET/);
    });
    c.tasks.forEach((t, i) => {
      const s = stmts[c.categories.length + i] ?? "";
      expect(s).toMatch(/^INSERT INTO catalog_tasks \(id, category_id, text, active\)/);
      expect(s).toContain(sqlString(t.id));
      expect(s).toMatch(/ON CONFLICT \(id\) DO UPDATE SET/);
    });
    const n = c.categories.length + c.tasks.length;
    expect(stmts[n]).toMatch(/^UPDATE categories SET active = 0 WHERE active = 1 AND id NOT IN \(/);
    expect(stmts[n + 1]).toMatch(/^UPDATE catalog_tasks SET active = 0 WHERE active = 1 AND id NOT IN \(/);
    for (const cat of c.categories) expect(stmts[n]).toContain(sqlString(cat.id));
    for (const t of c.tasks) expect(stmts[n + 1]).toContain(sqlString(t.id));
  });

  it("follows file order, not id order", () => {
    const c = real();
    c.categories.reverse();
    const stmts: string[] = catalogToStatements(c);
    expect(stmts[0]).toContain("'puzzle'");
    expect(stmts[4]).toContain("'beer'");
  });
});

describe("§7 sync: sqlString", () => {
  it.each<[string, string]>([
    ["plain", "'plain'"],
    ["", "''"],
    ["it's", "'it''s'"],
    ["''", "''''''"],
    [`say "hi"`, `'say "hi"'`],
    ["back\\slash", "'back\\slash'"],
    ["a;b -- c", "'a;b -- c'"],
    ["🍺", "'🍺'"],
  ])("quotes %j as %j", (input, expected) => {
    expect(sqlString(input)).toBe(expected);
  });
});
