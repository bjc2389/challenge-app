// SPEC.md §7 ("The admin page shows it read-only"; rows missing from the file are marked
// inactive, never deleted), §9 /admin ("A read-only view of the catalog"), §10
// GET /api/admin/catalog. Approved M6 plan:
// - `{ categories: [{ id, name, order, countPerGame, final, active, tasks: [{ id, text, active }] }] }`;
// - every category and task, inactive ones too;
// - categories: active first, then `order`, then id; tasks nested and sorted by id;
// - read-only: D1 is unchanged.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { expectError, makeDeps } from "./helpers/auth";
import { insertCatalogTask, insertCategory, resetDb, snapshotCatalog } from "./helpers/db";
import {
  ADMIN_CATALOG_URL,
  ADMIN_CATEGORY_KEYS,
  ADMIN_TASK_KEYS,
  admin,
  getAdminCatalog,
  sortedKeys,
  type AdminApi,
  type AdminCatalogBody,
} from "./helpers/admin";
import { anonymous, expectApiError, player, seedRollCatalog } from "./helpers/game";

let adm: AdminApi;
const deps = makeDeps().deps;

beforeEach(async () => {
  await resetDb();
  adm = await admin(deps);
});

/** seedRollCatalog (helpers/game.ts) as the admin view must show it. */
const ROLL_CATALOG_VIEW: AdminCatalogBody = {
  categories: [
    {
      id: "drinks",
      name: "Drinks",
      order: 1,
      countPerGame: 2,
      final: false,
      active: true,
      tasks: [
        { id: "drinks-a", text: "Drink A", active: true },
        { id: "drinks-b", text: "Drink B", active: true },
        { id: "drinks-c", text: "Drink C", active: true },
        { id: "drinks-off", text: "Drink Off", active: false },
      ],
    },
    {
      id: "food",
      name: "Food",
      order: 2,
      countPerGame: 1,
      final: false,
      active: true,
      tasks: [
        { id: "food-a", text: "Food A", active: true },
        { id: "food-b", text: "Food B", active: true },
      ],
    },
    {
      id: "puzzle",
      name: "Final Puzzle",
      order: 4,
      countPerGame: 1,
      final: true,
      active: true,
      tasks: [
        { id: "puzzle-a", text: "Puzzle A", active: true },
        { id: "puzzle-b", text: "Puzzle B", active: true },
      ],
    },
    // Inactive categories come after every active one, even with a lower order.
    {
      id: "retired",
      name: "Retired",
      order: 3,
      countPerGame: 1,
      final: false,
      active: false,
      tasks: [{ id: "retired-a", text: "Retired A", active: true }],
    },
    {
      id: "old-puzzle",
      name: "Old Puzzle",
      order: 5,
      countPerGame: 1,
      final: true,
      active: false,
      tasks: [{ id: "old-puzzle-a", text: "Old Puzzle A", active: true }],
    },
  ],
};

describe("§3 §10 GET /api/admin/catalog is admin-only", () => {
  it("anonymous gets 401", async () => {
    await expectError(await anonymous(deps, "GET", ADMIN_CATALOG_URL), 401, "unauthorized", "Log in to continue");
  });

  it("a player gets 403", async () => {
    const api = await player(deps);
    await expectError(await api.get(ADMIN_CATALOG_URL), 403, "forbidden", "Admin access required");
  });
});

describe("§7 §9 §10 GET /api/admin/catalog shows the whole catalog", () => {
  beforeEach(async () => {
    await seedRollCatalog();
  });

  it("every category and task, inactive ones included, with the planned fields and order", async () => {
    expect(await getAdminCatalog(adm)).toEqual(ROLL_CATALOG_VIEW);
  });

  it("has exactly the planned keys at every level", async () => {
    const body = await getAdminCatalog(adm);
    expect(sortedKeys(body)).toEqual(["categories"]);
    expect(body.categories).toHaveLength(5);
    for (const cat of body.categories) {
      expect(sortedKeys(cat)).toEqual(ADMIN_CATEGORY_KEYS);
      expect(typeof cat.final).toBe("boolean");
      expect(typeof cat.active).toBe("boolean");
      for (const task of cat.tasks) {
        expect(sortedKeys(task)).toEqual(ADMIN_TASK_KEYS);
        expect(typeof task.active).toBe("boolean");
      }
    }
  });

  it("every task in D1 appears exactly once, under its own category", async () => {
    const { tasks } = await snapshotCatalog();
    const body = await getAdminCatalog(adm);
    const shown = body.categories.flatMap((c) => c.tasks.map((t) => `${c.id}/${t.id}`)).sort();
    expect(shown).toEqual(tasks.map((t) => `${t.category_id as string}/${t.id as string}`).sort());
  });

  it("does not change D1", async () => {
    const before = await snapshotCatalog();
    await getAdminCatalog(adm);
    await getAdminCatalog(adm);
    expect(await snapshotCatalog()).toEqual(before);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("%s /api/admin/catalog is not a route (404) and changes nothing", async (method) => {
    const before = await snapshotCatalog();
    const res = await adm.request(method, ADMIN_CATALOG_URL, { categories: [] });
    await expectApiError(res, 404, "not_found");
    expect(await snapshotCatalog()).toEqual(before);
  });
});

describe("§7 §10 GET /api/admin/catalog ordering details", () => {
  it("an empty catalog gives { categories: [] }", async () => {
    expect(await getAdminCatalog(adm)).toEqual({ categories: [] });
  });

  it("categories with the same order and active flag sort by id", async () => {
    await insertCategory("zeta", { name: "Zeta", sortOrder: 7 });
    await insertCategory("alpha", { name: "Alpha", sortOrder: 7 });
    await insertCategory("mid", { name: "Mid", sortOrder: 3 });
    const ids = (await getAdminCatalog(adm)).categories.map((c) => c.id);
    expect(ids).toEqual(["mid", "alpha", "zeta"]);
  });

  it("tasks are sorted by id, not by insertion order or text", async () => {
    await insertCategory("cat", { name: "Cat", sortOrder: 1 });
    await insertCatalogTask("task-z", "cat", "Aardvark");
    await insertCatalogTask("task-a", "cat", "Zebra");
    await insertCatalogTask("task-m", "cat", "Middle");
    const tasks = (await getAdminCatalog(adm)).categories[0]?.tasks;
    expect(tasks?.map((t) => t.id)).toEqual(["task-a", "task-m", "task-z"]);
  });

  it("a category with no tasks has tasks: []", async () => {
    await insertCategory("empty", { name: "Empty", sortOrder: 1, countPerGame: 2 });
    expect(await getAdminCatalog(adm)).toEqual({
      categories: [{ id: "empty", name: "Empty", order: 1, countPerGame: 2, final: false, active: true, tasks: [] }],
    });
  });

  it("an inactive task in an inactive category is still shown", async () => {
    await insertCategory("gone", { name: "Gone", sortOrder: 1 });
    await insertCatalogTask("gone-a", "gone", "Gone A");
    await env.DB.batch([
      env.DB.prepare("UPDATE categories SET active = 0 WHERE id = ?").bind("gone"),
      env.DB.prepare("UPDATE catalog_tasks SET active = 0 WHERE id = ?").bind("gone-a"),
    ]);
    expect(await getAdminCatalog(adm)).toEqual({
      categories: [
        {
          id: "gone",
          name: "Gone",
          order: 1,
          countPerGame: 1,
          final: false,
          active: false,
          tasks: [{ id: "gone-a", text: "Gone A", active: false }],
        },
      ],
    });
  });
});
