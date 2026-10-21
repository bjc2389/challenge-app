import type { CatalogCategory, CatalogTask, RandomInt, RolledTask } from "./types";

type Result = { ok: true; tasks: RolledTask[] } | { ok: false; categoryName: string | null; message: string };

const byId = (a: CatalogTask, b: CatalogTask) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// SPEC.md §5: each active category contributes countPerGame distinct active tasks,
// category by category in order, with the single final category always last.
export function rollTasks(categories: CatalogCategory[], tasks: CatalogTask[], rand: RandomInt): Result {
  const active = categories.filter((c) => c.active);
  const finals = active.filter((c) => c.isFinal);
  const final = finals[0];
  if (finals.length !== 1 || !final || final.countPerGame !== 1) {
    return { ok: false, categoryName: null, message: "The catalog needs exactly one final category" };
  }
  const ordered = [...active.filter((c) => !c.isFinal).sort((a, b) => a.sortOrder - b.sortOrder), final];

  const rolled: RolledTask[] = [];
  for (const category of ordered) {
    // Sorting first makes the picks depend only on `rand`, not on row order.
    const pool = tasks.filter((t) => t.active && t.categoryId === category.id).sort(byId);
    const count = category.countPerGame;
    if (pool.length < count) {
      return { ok: false, categoryName: category.name, message: `Not enough active tasks in ${category.name}` };
    }
    // Partial Fisher–Yates: the first `count` entries become a uniform random pick.
    for (let i = 0; i < count; i++) {
      const j = i + rand(pool.length - i);
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    for (const task of pool.slice(0, count)) {
      rolled.push({
        catalogTaskId: task.id,
        categoryId: category.id,
        text: task.text,
        sortOrder: rolled.length + 1,
        isFinal: category.isFinal,
      });
    }
  }
  return { ok: true, tasks: rolled };
}
