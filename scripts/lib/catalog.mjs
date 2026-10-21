// Catalog validation and sync SQL (SPEC.md §7). Pure: no Node imports, so the
// deploy scripts and the Workers test pool can both load it. Never import this
// from src/client or src/worker; the app reads the catalog from D1.

/**
 * @typedef {{ id: string; name: string; order: number; countPerGame: number; final?: boolean }} Category
 * @typedef {{ id: string; category: string; text: string; active?: boolean }} Task
 * @typedef {{ categories: Category[]; tasks: Task[] }} Catalog
 */

export const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MAX_TEXT_LENGTH = 200;
// C0 and C1 control characters and DEL, which includes newlines and tabs.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

const CATEGORY_KEYS = { id: "id", name: "text", order: "int", countPerGame: "int", final: "bool" };
const TASK_KEYS = { id: "id", category: "string", text: "text", active: "bool" };
const REQUIRED = { categories: ["id", "name", "order", "countPerGame"], tasks: ["id", "category", "text"] };

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks one entry's keys and field types. Returns false when it isn't an object.
 * @param {unknown} entry
 * @param {string} path
 * @param {Record<string, string>} keys
 * @param {string[]} required
 * @param {string[]} errors
 */
function checkFields(entry, path, keys, required, errors) {
  if (!isObject(entry)) {
    errors.push(`${path}: must be an object`);
    return false;
  }
  for (const key of Object.keys(entry)) {
    if (!(key in keys)) errors.push(`${path}.${key}: unknown key "${key}"`);
  }
  for (const key of required) {
    if (!(key in entry)) errors.push(`${path}.${key}: is required`);
  }
  for (const [key, kind] of Object.entries(keys)) {
    if (!(key in entry)) continue;
    const value = entry[key];
    const at = `${path}.${key}`;
    if (kind === "bool") {
      if (typeof value !== "boolean") errors.push(`${at}: must be a boolean`);
    } else if (kind === "int") {
      if (!Number.isSafeInteger(value)) errors.push(`${at}: must be an integer`);
    } else if (typeof value !== "string" || value === "") {
      errors.push(`${at}: must be a non-empty string`);
    } else if (kind === "id" && !KEBAB_ID.test(value)) {
      errors.push(`${at}: "${value}" is not kebab-case`);
    } else if (kind === "text" && (CONTROL_CHARS.test(value) || value.length > MAX_TEXT_LENGTH)) {
      errors.push(`${at}: must be at most ${MAX_TEXT_LENGTH} characters with no control characters or newlines`);
    }
  }
  return true;
}

/**
 * Reports a later entry whose `key` repeats an earlier one.
 * @param {Array<Record<string, unknown>>} entries
 * @param {string} listName
 * @param {string} key
 * @param {string[]} errors
 */
function checkUnique(entries, listName, key, errors) {
  const seen = new Set();
  entries.forEach((entry, i) => {
    const value = entry[key];
    if (value === undefined) return;
    if (seen.has(value)) errors.push(`${listName}[${i}].${key}: duplicate ${key} ${JSON.stringify(value)}`);
    seen.add(value);
  });
}

/**
 * Returns every problem with the catalog, each as "path: message". Empty means valid.
 * @param {unknown} input
 * @returns {string[]}
 */
export function validateCatalog(input) {
  /** @type {string[]} */
  const errors = [];
  if (!isObject(input)) return ["catalog: must be an object with categories and tasks"];
  for (const key of Object.keys(input)) {
    if (key !== "categories" && key !== "tasks") errors.push(`catalog.${key}: unknown key "${key}"`);
  }
  for (const list of ["categories", "tasks"]) {
    const value = input[list];
    if (!Array.isArray(value) || value.length === 0) errors.push(`${list}: must be a non-empty array`);
  }
  if (errors.length > 0) return errors;

  const categories = /** @type {unknown[]} */ (input.categories);
  const tasks = /** @type {unknown[]} */ (input.tasks);
  const okCategories = /** @type {Array<Record<string, unknown>>} */ (
    categories.filter((c, i) => checkFields(c, `categories[${i}]`, CATEGORY_KEYS, REQUIRED.categories, errors))
  );
  const okTasks = /** @type {Array<Record<string, unknown>>} */ (
    tasks.filter((t, i) => checkFields(t, `tasks[${i}]`, TASK_KEYS, REQUIRED.tasks, errors))
  );

  // Rule 1: IDs are unique (kebab-case is checked per field above).
  checkUnique(okCategories, "categories", "id", errors);
  checkUnique(okCategories, "categories", "order", errors);
  checkUnique(okTasks, "tasks", "id", errors);

  // Rule 2: every task's category exists.
  const categoryIds = new Set(okCategories.map((c) => c.id));
  tasks.forEach((task, i) => {
    if (isObject(task) && typeof task.category === "string" && !categoryIds.has(task.category)) {
      errors.push(`tasks[${i}].category: unknown category "${task.category}"`);
    }
  });

  // Rule 3: exactly one final category, contributing one task.
  const finals = okCategories.filter((c) => c.final === true);
  if (finals.length !== 1) errors.push(`categories: exactly one category must be final (found ${finals.length})`);
  categories.forEach((c, i) => {
    if (isObject(c) && c.final === true && c.countPerGame !== 1) {
      errors.push(`categories[${i}].countPerGame: the final category must have countPerGame 1`);
    }
  });

  // Rules 4 and 5: countPerGame is at least 1, with that many active tasks.
  categories.forEach((c, i) => {
    if (!isObject(c) || !Number.isSafeInteger(c.countPerGame)) return;
    const count = /** @type {number} */ (c.countPerGame);
    if (count < 1) {
      errors.push(`categories[${i}].countPerGame: must be at least 1`);
      return;
    }
    const active = okTasks.filter((t) => t.category === c.id && t.active !== false).length;
    if (active < count) {
      errors.push(`categories[${i}]: needs at least ${count} active task(s) but has ${active}`);
    }
  });

  return errors;
}

/**
 * Returns the catalog typed, or throws an Error listing every problem.
 * @param {unknown} input
 * @returns {Catalog}
 */
export function parseCatalog(input) {
  const errors = validateCatalog(input);
  if (errors.length > 0) throw new Error(`Invalid catalog:\n${errors.join("\n")}`);
  return /** @type {Catalog} */ (input);
}

/**
 * A SQL string literal. `wrangler d1 execute --file` takes no bound parameters,
 * so values are written inline and quotes are doubled.
 * @param {string} value
 */
export function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

/** @param {number} value */
function sqlInt(value) {
  if (!Number.isSafeInteger(value)) throw new Error(`Not a safe integer: ${value}`);
  return String(value);
}

/**
 * Upserts every category and task, then marks rows missing from the file
 * inactive. Never deletes. One statement per entry, in file order.
 * @param {Catalog} catalog
 * @returns {string[]}
 */
export function catalogToStatements(catalog) {
  const categories = catalog.categories.map(
    (c) =>
      "INSERT INTO categories (id, name, sort_order, count_per_game, is_final, active) " +
      `VALUES (${sqlString(c.id)}, ${sqlString(c.name)}, ${sqlInt(c.order)}, ${sqlInt(c.countPerGame)}, ` +
      `${c.final === true ? 1 : 0}, 1) ` +
      "ON CONFLICT (id) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order, " +
      "count_per_game = excluded.count_per_game, is_final = excluded.is_final, active = excluded.active;",
  );
  const tasks = catalog.tasks.map(
    (t) =>
      "INSERT INTO catalog_tasks (id, category_id, text, active) " +
      `VALUES (${sqlString(t.id)}, ${sqlString(t.category)}, ${sqlString(t.text)}, ${t.active === false ? 0 : 1}) ` +
      "ON CONFLICT (id) DO UPDATE SET category_id = excluded.category_id, text = excluded.text, " +
      "active = excluded.active;",
  );
  const idList = (/** @type {Array<{ id: string }>} */ rows) => rows.map((r) => sqlString(r.id)).join(", ");
  return [
    ...categories,
    ...tasks,
    `UPDATE categories SET active = 0 WHERE active = 1 AND id NOT IN (${idList(catalog.categories)});`,
    `UPDATE catalog_tasks SET active = 0 WHERE active = 1 AND id NOT IN (${idList(catalog.tasks)});`,
  ];
}

/**
 * The full sync file: a header comment, then one statement per line.
 * @param {Catalog} catalog
 */
export function catalogToSql(catalog) {
  return ["-- Generated from catalog/catalog.json by `npm run catalog:sql`. Do not edit.", ...catalogToStatements(catalog)]
    .join("\n")
    .concat("\n");
}
