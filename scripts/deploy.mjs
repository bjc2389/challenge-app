// Deploys one environment. Only Cloudflare builds run this (see SPEC.md §2).
// Order: D1 migrations, then catalog sync SQL, then the Worker itself.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const env = process.argv[2];
if (env !== "staging" && env !== "production") {
  console.error("Usage: node scripts/deploy.mjs <staging|production>");
  process.exit(1);
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
const wrangler = (...args) => run("npx", ["wrangler", ...args, "--env", env]);

// TODO(M2): the D1 database and catalog sync arrive in M2. Make both steps
// unconditional then, so a missing piece fails the deploy instead of skipping.
const hasMigrations =
  existsSync("migrations") && readdirSync("migrations").some((f) => f.endsWith(".sql"));
if (hasMigrations) {
  wrangler("d1", "migrations", "apply", "DB", "--remote");
} else {
  console.log("Skipping D1 migrations: no migrations/*.sql yet (pre-M2).");
}

const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
if (scripts["catalog:sql"]) {
  run("npm", ["run", "catalog:sql"]);
  wrangler("d1", "execute", "DB", "--remote", "--file", "dist/catalog.sql");
} else {
  console.log("Skipping catalog sync: no catalog:sql script yet (pre-M2).");
}

wrangler("deploy");
