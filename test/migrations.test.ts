// SPEC.md §8 data model (D1), plus the schema details Bob approved for M2:
// STRICT tables, 0/1 booleans with CHECK, INTEGER epoch-ms times, no ON DELETE CASCADE.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MINI_GAME_TASKS,
  T0,
  deleteGameBatch,
  execableSql,
  gameRowCounts,
  insertCatalogTask,
  insertCategory,
  insertGame,
  insertGameTask,
  insertTeam,
  resetDb,
  seedFullGame,
  seedMiniCatalog,
} from "./helpers/db";

type ColumnSpec = { type: "TEXT" | "INTEGER"; pk?: number; notnull?: 0 | 1 };

const TEXT_PK: ColumnSpec = { type: "TEXT", pk: 1 };
const INT_PK: ColumnSpec = { type: "INTEGER", pk: 1 };
const TEXT: ColumnSpec = { type: "TEXT" };
const INT: ColumnSpec = { type: "INTEGER" };
const NULLABLE_INT: ColumnSpec = { type: "INTEGER", notnull: 0 };

/** §8 columns. `notnull` is asserted only where the approved plan states it. */
const SCHEMA: Record<string, Record<string, ColumnSpec>> = {
  categories: {
    id: TEXT_PK,
    name: TEXT,
    sort_order: INT,
    count_per_game: INT,
    is_final: INT,
    active: INT,
  },
  catalog_tasks: {
    id: TEXT_PK,
    category_id: TEXT,
    text: TEXT,
    active: INT,
  },
  games: {
    id: INT_PK,
    code: { type: "TEXT", notnull: 1 },
    status: { type: "TEXT", notnull: 1 },
    is_test: INT,
    version: INT,
    created_at: { type: "INTEGER", notnull: 1 },
    rolled_at: NULLABLE_INT,
    started_at: NULLABLE_INT,
    ends_at: NULLABLE_INT,
    ended_at: NULLABLE_INT,
    end_reason: { type: "TEXT", notnull: 0 },
    winner_team_id: NULLABLE_INT,
  },
  teams: {
    id: INT_PK,
    game_id: INT,
    slot: INT,
    name: TEXT,
  },
  game_tasks: {
    id: INT_PK,
    game_id: INT,
    catalog_task_id: TEXT,
    category_id: TEXT,
    text: TEXT,
    sort_order: INT,
    is_final: INT,
  },
  team_tasks: {
    team_id: { type: "INTEGER", pk: 1 },
    game_task_id: { type: "INTEGER", pk: 2 },
    completed_at: NULLABLE_INT,
  },
  task_events: {
    id: INT_PK,
    game_id: INT,
    team_id: INT,
    game_task_id: INT,
    action: TEXT,
    at: { type: "INTEGER", notnull: 1 },
  },
};

/** Expected foreign keys: [table, column, referenced table]. */
const FOREIGN_KEYS: Array<[string, string, string]> = [
  ["catalog_tasks", "category_id", "categories"],
  ["games", "winner_team_id", "teams"],
  ["teams", "game_id", "games"],
  ["game_tasks", "game_id", "games"],
  ["game_tasks", "catalog_task_id", "catalog_tasks"],
  ["game_tasks", "category_id", "categories"],
  ["team_tasks", "team_id", "teams"],
  ["team_tasks", "game_task_id", "game_tasks"],
  ["task_events", "game_id", "games"],
  ["task_events", "team_id", "teams"],
  ["task_events", "game_task_id", "game_tasks"],
];

type TableInfo = { name: string; type: string; notnull: number; pk: number; dflt_value: unknown };
type FkInfo = { table: string; from: string; to: string; on_delete: string; on_update: string };

async function tableInfo(table: string): Promise<TableInfo[]> {
  // PRAGMA arguments cannot be bound; `table` only ever comes from the SCHEMA constant above.
  return (await env.DB.prepare(`PRAGMA table_info(${table})`).all<TableInfo>()).results;
}

async function foreignKeys(table: string): Promise<FkInfo[]> {
  return (await env.DB.prepare(`PRAGMA foreign_key_list(${table})`).all<FkInfo>()).results;
}

function insertGameRow(cols: Record<string, unknown>) {
  const names = Object.keys(cols);
  const sql = `INSERT INTO games (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
  return env.DB.prepare(sql)
    .bind(...Object.values(cols))
    .run();
}

beforeEach(async () => {
  await resetDb();
});

describe("§8 data model: migrations", () => {
  it("there is at least one numbered migration file", () => {
    expect(env.TEST_MIGRATIONS.length).toBeGreaterThan(0);
    for (const m of env.TEST_MIGRATIONS) expect(m.name).toMatch(/^\d{4}_.+\.sql$/);
    const names = env.TEST_MIGRATIONS.map((m) => m.name);
    expect(names).toEqual([...names].sort());
  });

  it("migrations are additive: no DROP or DELETE FROM (CLAUDE.md: additive, backward-compatible)", () => {
    for (const m of env.TEST_MIGRATIONS) {
      for (const q of m.queries) expect(q, m.name).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|VIEW|TRIGGER)\b|\bDELETE\s+FROM\b/i);
    }
  });
});

describe("§8 data model: tables and columns", () => {
  it("all 7 tables exist", async () => {
    const rows = (
      await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name").bind("table").all<{
        name: string;
      }>()
    ).results.map((r) => r.name);
    for (const t of Object.keys(SCHEMA)) expect(rows, `table ${t}`).toContain(t);
  });

  it.each(Object.keys(SCHEMA))("%s is a STRICT table", async (table) => {
    const rows = (await env.DB.prepare(`PRAGMA table_list(${table})`).all<{ name: string; strict: number }>())
      .results;
    expect(rows.find((r) => r.name === table)?.strict).toBe(1);
  });

  it.each(Object.entries(SCHEMA))("%s has exactly the §8 columns with the right types", async (table, spec) => {
    const info = await tableInfo(table);
    expect(info.map((c) => c.name).sort()).toEqual(Object.keys(spec).sort());
    for (const col of info) {
      const want = spec[col.name] as ColumnSpec;
      expect(col.type.toUpperCase(), `${table}.${col.name} type`).toBe(want.type);
      expect(col.pk, `${table}.${col.name} pk`).toBe(want.pk ?? 0);
      if (want.notnull !== undefined) expect(col.notnull, `${table}.${col.name} notnull`).toBe(want.notnull);
    }
  });

  it.each(FOREIGN_KEYS)("%s.%s references %s, with no ON DELETE CASCADE", async (table, from, to) => {
    const fks = await foreignKeys(table);
    const fk = fks.find((f) => f.from === from);
    expect(fk, `${table}.${from} foreign key`).toBeDefined();
    expect(fk?.table).toBe(to);
    expect(fk?.on_delete.toUpperCase()).not.toBe("CASCADE");
  });

  it("no foreign key anywhere uses ON DELETE CASCADE or SET NULL", async () => {
    for (const table of Object.keys(SCHEMA)) {
      for (const fk of await foreignKeys(table)) {
        expect(["NO ACTION", "RESTRICT"], `${table}.${fk.from}`).toContain(fk.on_delete.toUpperCase());
      }
    }
  });
});

describe("§8 data model: defaults", () => {
  it("categories.active defaults to 1", async () => {
    await insertCategory("cat-a", { sortOrder: 1 });
    const row = await env.DB.prepare("SELECT active FROM categories WHERE id = ?").bind("cat-a").first();
    expect(row).toEqual({ active: 1 });
  });

  it("catalog_tasks.active defaults to 1", async () => {
    await insertCategory("cat-a", { sortOrder: 1 });
    await insertCatalogTask("task-a1", "cat-a");
    const row = await env.DB.prepare("SELECT active FROM catalog_tasks WHERE id = ?").bind("task-a1").first();
    expect(row).toEqual({ active: 1 });
  });

  it("a game inserted with only code and created_at gets status setup, is_test 0, version 0 and null times", async () => {
    const id = await insertGame("ABCDE", T0);
    const row = await env.DB.prepare("SELECT * FROM games WHERE id = ?").bind(id).first();
    expect(row).toEqual({
      id,
      code: "ABCDE",
      status: "setup",
      is_test: 0,
      version: 0,
      created_at: T0,
      rolled_at: null,
      started_at: null,
      ends_at: null,
      ended_at: null,
      end_reason: null,
      winner_team_id: null,
    });
  });

  it("team_tasks.completed_at defaults to null (not done)", async () => {
    await seedMiniCatalog();
    const gameId = await insertGame("ABCDE");
    const teamId = await insertTeam(gameId, 1, "Team One");
    const gtId = await insertGameTask(gameId, MINI_GAME_TASKS[0]!, 1);
    await env.DB.prepare("INSERT INTO team_tasks (team_id, game_task_id) VALUES (?, ?)").bind(teamId, gtId).run();
    const row = await env.DB.prepare("SELECT completed_at FROM team_tasks WHERE team_id = ? AND game_task_id = ?")
      .bind(teamId, gtId)
      .first();
    expect(row).toEqual({ completed_at: null });
  });

  it("stores epoch-millisecond times as exact integers", async () => {
    const at = Date.UTC(2026, 11, 31, 23, 59, 59, 999);
    const id = await insertGame("ABCDE", at);
    const row = await env.DB.prepare("SELECT created_at, typeof(created_at) AS t FROM games WHERE id = ?")
      .bind(id)
      .first();
    expect(row).toEqual({ created_at: at, t: "integer" });
  });
});

describe("§8 data model: constraints on categories and catalog_tasks", () => {
  it("rejects count_per_game 0", async () => {
    await expect(insertCategory("cat-a", { sortOrder: 1, countPerGame: 0 })).rejects.toThrow(/CHECK/);
  });

  it("rejects is_final 2", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO categories (id, name, sort_order, count_per_game, is_final) VALUES (?, ?, ?, ?, ?)",
      )
        .bind("cat-a", "A", 1, 1, 2)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("rejects categories.active 2", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO categories (id, name, sort_order, count_per_game, is_final, active) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind("cat-a", "A", 1, 1, 0, 2)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("rejects a duplicate category id", async () => {
    await insertCategory("cat-a", { sortOrder: 1 });
    await expect(insertCategory("cat-a", { sortOrder: 2 })).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it("rejects catalog_tasks.active -1", async () => {
    await insertCategory("cat-a", { sortOrder: 1 });
    await expect(
      env.DB.prepare("INSERT INTO catalog_tasks (id, category_id, text, active) VALUES (?, ?, ?, ?)")
        .bind("task-a1", "cat-a", "T", -1)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("rejects a catalog task whose category does not exist (foreign keys are enforced)", async () => {
    await expect(insertCatalogTask("task-x", "no-such-category")).rejects.toThrow(/FOREIGN KEY/);
  });

  it("rejects text in an INTEGER column (STRICT)", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO categories (id, name, sort_order, count_per_game, is_final) VALUES (?, ?, ?, ?, ?)",
      )
        .bind("cat-a", "A", "first", 1, 0)
        .run(),
    ).rejects.toThrow(/cannot store|datatype/i);
  });
});

describe("§8 data model: constraints on games", () => {
  it("rejects a duplicate code", async () => {
    await insertGame("ABCDE");
    await expect(insertGame("ABCDE")).rejects.toThrow(/UNIQUE/);
  });

  it("rejects a null code", async () => {
    await expect(insertGameRow({ code: null, created_at: T0 })).rejects.toThrow(/NOT NULL/);
  });

  it("rejects a missing created_at", async () => {
    await expect(insertGameRow({ code: "ABCDE" })).rejects.toThrow(/NOT NULL/);
  });

  it("rejects a text created_at (STRICT)", async () => {
    await expect(insertGameRow({ code: "ABCDE", created_at: "yesterday" })).rejects.toThrow(/cannot store|datatype/i);
  });

  it.each(["setup", "rolled", "active", "finished", "abandoned"])("accepts status %j", async (status) => {
    // A finished game needs an end_reason (0002 triggers).
    const endReason = status === "finished" ? "completed" : null;
    await insertGameRow({ code: "ABCDE", created_at: T0, status, end_reason: endReason });
    const row = await env.DB.prepare("SELECT status FROM games WHERE code = ?").bind("ABCDE").first();
    expect(row).toEqual({ status });
  });

  it.each(["paused", "SETUP", "", "done"])("rejects status %j", async (status) => {
    await expect(insertGameRow({ code: "ABCDE", created_at: T0, status })).rejects.toThrow(/CHECK/);
  });

  it("rejects a null status", async () => {
    await expect(insertGameRow({ code: "ABCDE", created_at: T0, status: null })).rejects.toThrow(/NOT NULL/);
  });

  it.each(["completed", "timeout"])("accepts end_reason %j on a finished game", async (endReason) => {
    await insertGameRow({ code: "ABCDE", created_at: T0, status: "finished", end_reason: endReason });
    const row = await env.DB.prepare("SELECT end_reason FROM games WHERE code = ?").bind("ABCDE").first();
    expect(row).toEqual({ end_reason: endReason });
  });

  it.each(["abandoned", "forfeit", "COMPLETED", ""])("rejects end_reason %j", async (endReason) => {
    await expect(
      insertGameRow({ code: "ABCDE", created_at: T0, status: "finished", end_reason: endReason }),
    ).rejects.toThrow(/CHECK/);
  });

  it.each([-1, 2])("rejects is_test %j", async (isTest) => {
    await expect(insertGameRow({ code: "ABCDE", created_at: T0, is_test: isTest })).rejects.toThrow(/CHECK/);
  });

  it("accepts is_test 1", async () => {
    await insertGameRow({ code: "ABCDE", created_at: T0, is_test: 1 });
    const row = await env.DB.prepare("SELECT is_test FROM games WHERE code = ?").bind("ABCDE").first();
    expect(row).toEqual({ is_test: 1 });
  });

  it("rejects a winner_team_id that does not exist", async () => {
    await expect(
      insertGameRow({ code: "ABCDE", created_at: T0, status: "finished", end_reason: "completed", winner_team_id: 999_999 }),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});

// §8: end_reason and winner_team_id are set only on finished games (0002 triggers).
describe("§8 data model: end state matches status", () => {
  const END_STATE_ERROR = /only finished games have an end_reason or winner/;

  it.each(["setup", "rolled", "active", "abandoned"])("rejects an end_reason on a %s game", async (status) => {
    await expect(insertGameRow({ code: "ABCDE", created_at: T0, status, end_reason: "completed" })).rejects.toThrow(
      END_STATE_ERROR,
    );
  });

  it("rejects a finished game with no end_reason", async () => {
    await expect(insertGameRow({ code: "ABCDE", created_at: T0, status: "finished" })).rejects.toThrow(END_STATE_ERROR);
  });

  it("accepts a finished tie: end_reason timeout with no winner", async () => {
    await insertGameRow({ code: "ABCDE", created_at: T0, status: "finished", end_reason: "timeout" });
    const row = await env.DB.prepare("SELECT winner_team_id FROM games WHERE code = ?").bind("ABCDE").first();
    expect(row).toEqual({ winner_team_id: null });
  });

  it("accepts an abandoned game with no end_reason or winner", async () => {
    await insertGameRow({ code: "ABCDE", created_at: T0, status: "abandoned" });
    const row = await env.DB.prepare("SELECT end_reason, winner_team_id FROM games WHERE code = ?").bind("ABCDE").first();
    expect(row).toEqual({ end_reason: null, winner_team_id: null });
  });

  it("rejects setting a winner on an active game", async () => {
    await seedMiniCatalog();
    const { gameId, teamIds } = await seedFullGame("ABCDE");
    await env.DB.prepare("UPDATE games SET status = 'active', end_reason = NULL, winner_team_id = NULL WHERE id = ?")
      .bind(gameId)
      .run();
    await expect(
      env.DB.prepare("UPDATE games SET winner_team_id = ? WHERE id = ?").bind(teamIds[0], gameId).run(),
    ).rejects.toThrow(END_STATE_ERROR);
  });

  it("rejects moving a finished game back to active without clearing its end state", async () => {
    await seedMiniCatalog();
    const { gameId } = await seedFullGame("ABCDE");
    await expect(env.DB.prepare("UPDATE games SET status = 'active' WHERE id = ?").bind(gameId).run()).rejects.toThrow(
      END_STATE_ERROR,
    );
  });

  it("allows finishing a game in one update", async () => {
    await seedMiniCatalog();
    const { gameId, teamIds } = await seedFullGame("ABCDE");
    await env.DB.prepare("UPDATE games SET status = 'active', end_reason = NULL, winner_team_id = NULL WHERE id = ?")
      .bind(gameId)
      .run();
    await env.DB.prepare("UPDATE games SET status = 'finished', end_reason = 'completed', winner_team_id = ? WHERE id = ?")
      .bind(teamIds[1], gameId)
      .run();
    const row = await env.DB.prepare("SELECT status, end_reason, winner_team_id FROM games WHERE id = ?").bind(gameId).first();
    expect(row).toEqual({ status: "finished", end_reason: "completed", winner_team_id: teamIds[1] });
  });
});

describe("§8 data model: constraints on teams", () => {
  it("accepts slots 1 and 2", async () => {
    const gameId = await insertGame("ABCDE");
    await insertTeam(gameId, 1, "Team One");
    await insertTeam(gameId, 2, "Team Two");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM teams WHERE game_id = ?").bind(gameId).first();
    expect(n).toEqual({ n: 2 });
  });

  it.each([0, 3])("rejects slot %j", async (slot) => {
    const gameId = await insertGame("ABCDE");
    await expect(insertTeam(gameId, slot, "Team")).rejects.toThrow(/CHECK/);
  });

  it("rejects a second team in the same slot of the same game", async () => {
    const gameId = await insertGame("ABCDE");
    await insertTeam(gameId, 1, "Team One");
    await expect(insertTeam(gameId, 1, "Team Again")).rejects.toThrow(/UNIQUE/);
  });

  it("allows the same slot in different games", async () => {
    const a = await insertGame("ABCDE");
    const b = await insertGame("FGHJK");
    await insertTeam(a, 1, "Team One");
    await insertTeam(b, 1, "Team One");
  });

  it("rejects a team whose game does not exist", async () => {
    await expect(insertTeam(999_999, 1, "Team")).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe("§8 data model: constraints on game_tasks", () => {
  beforeEach(async () => {
    await seedMiniCatalog();
  });

  const [taskA1, taskA2, taskFinal] = MINI_GAME_TASKS as [
    (typeof MINI_GAME_TASKS)[number],
    (typeof MINI_GAME_TASKS)[number],
    (typeof MINI_GAME_TASKS)[number],
  ];

  it("rejects a duplicate sort_order within a game", async () => {
    const gameId = await insertGame("ABCDE");
    await insertGameTask(gameId, taskA1, 1);
    await expect(insertGameTask(gameId, taskA2, 1)).rejects.toThrow(/UNIQUE/);
  });

  it("rejects the same catalog task twice in a game", async () => {
    const gameId = await insertGame("ABCDE");
    await insertGameTask(gameId, taskA1, 1);
    await expect(insertGameTask(gameId, taskA1, 2)).rejects.toThrow(/UNIQUE/);
  });

  it("rejects a second final task in the same game", async () => {
    const gameId = await insertGame("ABCDE");
    await insertGameTask(gameId, taskFinal, 1);
    await expect(insertGameTask(gameId, { ...taskA1, isFinal: 1 }, 2)).rejects.toThrow(/UNIQUE/);
  });

  it("allows one final task per game across different games, and many non-final tasks", async () => {
    const a = await insertGame("ABCDE");
    const b = await insertGame("FGHJK");
    await insertGameTask(a, taskA1, 1);
    await insertGameTask(a, taskA2, 2);
    await insertGameTask(a, taskFinal, 3);
    await insertGameTask(b, taskA1, 1);
    await insertGameTask(b, taskFinal, 2);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM game_tasks WHERE is_final = ?").bind(1).first();
    expect(n).toEqual({ n: 2 });
  });

  it("allows the same sort_order and catalog task in different games", async () => {
    const a = await insertGame("ABCDE");
    const b = await insertGame("FGHJK");
    await insertGameTask(a, taskA1, 1);
    await insertGameTask(b, taskA1, 1);
  });

  it("rejects is_final 2", async () => {
    const gameId = await insertGame("ABCDE");
    await expect(insertGameTask(gameId, { ...taskA1, isFinal: 2 as 1 }, 1)).rejects.toThrow(/CHECK/);
  });

  it("rejects a catalog_task_id that does not exist", async () => {
    const gameId = await insertGame("ABCDE");
    await expect(insertGameTask(gameId, { ...taskA1, catalogTaskId: "no-such-task" }, 1)).rejects.toThrow(
      /FOREIGN KEY/,
    );
  });

  it("rejects a category_id that does not exist", async () => {
    const gameId = await insertGame("ABCDE");
    await expect(insertGameTask(gameId, { ...taskA1, categoryId: "no-such-category" }, 1)).rejects.toThrow(
      /FOREIGN KEY/,
    );
  });

  it("rejects a game_id that does not exist", async () => {
    await expect(insertGameTask(999_999, taskA1, 1)).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe("§8 data model: constraints on team_tasks and task_events", () => {
  async function seedOne() {
    await seedMiniCatalog();
    const gameId = await insertGame("ABCDE");
    const teamId = await insertTeam(gameId, 1, "Team One");
    const gtId = await insertGameTask(gameId, MINI_GAME_TASKS[0]!, 1);
    return { gameId, teamId, gtId };
  }

  function insertTeamTask(teamId: number, gtId: number, completedAt: number | null) {
    return env.DB.prepare("INSERT INTO team_tasks (team_id, game_task_id, completed_at) VALUES (?, ?, ?)")
      .bind(teamId, gtId, completedAt)
      .run();
  }

  function insertEvent(gameId: number, teamId: number, gtId: number, action: string, at: unknown) {
    return env.DB.prepare(
      "INSERT INTO task_events (game_id, team_id, game_task_id, action, at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(gameId, teamId, gtId, action, at)
      .run();
  }

  it("rejects a duplicate (team_id, game_task_id)", async () => {
    const { teamId, gtId } = await seedOne();
    await insertTeamTask(teamId, gtId, null);
    await expect(insertTeamTask(teamId, gtId, T0)).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it("rejects a team_tasks row for a missing team or game task", async () => {
    const { teamId, gtId } = await seedOne();
    await expect(insertTeamTask(999_999, gtId, null)).rejects.toThrow(/FOREIGN KEY/);
    await expect(insertTeamTask(teamId, 999_999, null)).rejects.toThrow(/FOREIGN KEY/);
  });

  it.each(["complete", "undo"])("accepts action %j", async (action) => {
    const { gameId, teamId, gtId } = await seedOne();
    await insertEvent(gameId, teamId, gtId, action, T0);
    const row = await env.DB.prepare("SELECT action, at FROM task_events WHERE game_id = ?").bind(gameId).first();
    expect(row).toEqual({ action, at: T0 });
  });

  it.each(["redo", "COMPLETE", ""])("rejects action %j", async (action) => {
    const { gameId, teamId, gtId } = await seedOne();
    await expect(insertEvent(gameId, teamId, gtId, action, T0)).rejects.toThrow(/CHECK/);
  });

  it("rejects a null at", async () => {
    const { gameId, teamId, gtId } = await seedOne();
    await expect(insertEvent(gameId, teamId, gtId, "complete", null)).rejects.toThrow(/NOT NULL/);
  });

  it("rejects events pointing at missing rows", async () => {
    const { gameId, teamId, gtId } = await seedOne();
    await expect(insertEvent(999_999, teamId, gtId, "complete", T0)).rejects.toThrow(/FOREIGN KEY/);
    await expect(insertEvent(gameId, 999_999, gtId, "complete", T0)).rejects.toThrow(/FOREIGN KEY/);
    await expect(insertEvent(gameId, teamId, 999_999, "complete", T0)).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe("§8 data model: foreign_key_check after a catalog sync", () => {
  it("PRAGMA foreign_key_check is empty after syncing the real catalog and seeding a full game", async () => {
    // Imported here so the rest of this file does not depend on the catalog module.
    const { default: realCatalog } = await import("../catalog/catalog.json");
    const { catalogToSql, parseCatalog } = await import("../scripts/lib/catalog.mjs");
    await env.DB.exec(execableSql(catalogToSql(parseCatalog(structuredClone(realCatalog)))));
    const cats = await env.DB.prepare("SELECT COUNT(*) AS n FROM categories WHERE active = ?").bind(1).first();
    expect(cats).toEqual({ n: 5 });

    await seedFullGame("ABCDE", [
      { catalogTaskId: "beer-case-24", categoryId: "beer", text: "Finish a 24-can case", isFinal: 0 },
      { catalogTaskId: "four-loko", categoryId: "tough-drink", text: "Four Loko", isFinal: 0 },
      { catalogTaskId: "puzzle-500", categoryId: "puzzle", text: "500-piece puzzle", isFinal: 1 },
    ]);
    const check = await env.DB.prepare("PRAGMA foreign_key_check").all();
    expect(check.results).toEqual([]);
  });
});

describe("§8 data model: deleting a game is one explicit batch (no cascade)", () => {
  beforeEach(async () => {
    await seedMiniCatalog();
  });

  it("the seeded game has rows in every child table", async () => {
    const { gameId } = await seedFullGame("ABCDE");
    expect(await gameRowCounts(gameId)).toEqual({
      games: 1,
      teams: 2,
      game_tasks: 3,
      team_tasks: 6,
      task_events: 3,
    });
  });

  it("deleting the games row alone is rejected while children exist", async () => {
    const { gameId } = await seedFullGame("ABCDE");
    await expect(env.DB.prepare("DELETE FROM games WHERE id = ?").bind(gameId).run()).rejects.toThrow(
      /FOREIGN KEY/,
    );
    expect((await gameRowCounts(gameId)).games).toBe(1);
  });

  it("deleting the teams before clearing winner_team_id is rejected", async () => {
    const { gameId } = await seedFullGame("ABCDE");
    await expect(
      env.DB.batch([
        env.DB.prepare("DELETE FROM task_events WHERE game_id = ?").bind(gameId),
        env.DB.prepare("DELETE FROM team_tasks WHERE team_id IN (SELECT id FROM teams WHERE game_id = ?)").bind(
          gameId,
        ),
        env.DB.prepare("DELETE FROM game_tasks WHERE game_id = ?").bind(gameId),
        env.DB.prepare("DELETE FROM teams WHERE game_id = ?").bind(gameId),
      ]),
    ).rejects.toThrow(/FOREIGN KEY/);
    // The batch is atomic, so nothing was removed.
    expect(await gameRowCounts(gameId)).toEqual({
      games: 1,
      teams: 2,
      game_tasks: 3,
      team_tasks: 6,
      task_events: 3,
    });
  });

  it("the approved batch removes the game and every child row, and leaves other games alone", async () => {
    const a = await seedFullGame("ABCDE");
    const b = await seedFullGame("FGHJK");
    await env.DB.batch(deleteGameBatch(a.gameId));

    expect(await gameRowCounts(a.gameId)).toEqual({
      games: 0,
      teams: 0,
      game_tasks: 0,
      team_tasks: 0,
      task_events: 0,
    });
    for (const teamId of a.teamIds) {
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM team_tasks WHERE team_id = ?").bind(teamId).first();
      expect(n).toEqual({ n: 0 });
    }
    expect(await gameRowCounts(b.gameId)).toEqual({
      games: 1,
      teams: 2,
      game_tasks: 3,
      team_tasks: 6,
      task_events: 3,
    });
    const winner = await env.DB.prepare("SELECT winner_team_id FROM games WHERE id = ?").bind(b.gameId).first();
    expect(winner).toEqual({ winner_team_id: b.teamIds[0] });

    // The catalog is untouched by a game delete.
    const tasks = await env.DB.prepare("SELECT COUNT(*) AS n FROM catalog_tasks WHERE active = ?").bind(1).first();
    expect(tasks).toEqual({ n: 3 });
    expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});
