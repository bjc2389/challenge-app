// Deploys one environment. Only Cloudflare builds run this (see SPEC.md §2).
// Order: D1 migrations, then catalog sync SQL, then the Worker itself.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

const env = process.argv[2];
if (env !== "staging" && env !== "production") {
  console.error("Usage: node scripts/deploy.mjs <staging|production>");
  process.exit(1);
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
const wrangler = (...args) => run("npx", ["wrangler", ...args, "--env", env]);

// The D1 database and catalog sync arrive in M2; until then these steps are skipped.
const hasMigrations =
  existsSync("migrations") && readdirSync("migrations").some((f) => f.endsWith(".sql"));
if (hasMigrations) {
  wrangler("d1", "migrations", "apply", "DB", "--remote");
}

if (existsSync("scripts/catalog-sql.mjs")) {
  run("npm", ["run", "catalog:sql"]);
  wrangler("d1", "execute", "DB", "--remote", "--file", "dist/catalog.sql");
}

wrangler("deploy");
