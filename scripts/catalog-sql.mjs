// Validates catalog/catalog.json and writes the sync SQL to dist/catalog.sql
// (SPEC.md §7). Exits non-zero on an invalid catalog, before anything remote runs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { validateCatalog, catalogToSql } from "./lib/catalog.mjs";

const SOURCE = "catalog/catalog.json";
const OUTPUT = "dist/catalog.sql";

const catalog = JSON.parse(readFileSync(SOURCE, "utf8"));
const errors = validateCatalog(catalog);
if (errors.length > 0) {
  console.error(`${SOURCE} is invalid:\n${errors.map((e) => `  ${e}`).join("\n")}`);
  process.exit(1);
}

mkdirSync("dist", { recursive: true });
writeFileSync(OUTPUT, catalogToSql(catalog));
console.log(`Wrote ${OUTPUT}: ${catalog.categories.length} categories, ${catalog.tasks.length} tasks.`);
