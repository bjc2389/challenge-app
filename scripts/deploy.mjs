// Deploys one environment. Only Cloudflare builds run this (see SPEC.md §2).
// Order: validate and generate the catalog SQL locally, then D1 migrations,
// then the catalog sync, then the Worker itself. Any failure stops the deploy.
import { execFileSync } from "node:child_process";

const env = process.argv[2];
if (env !== "staging" && env !== "production") {
  console.error("Usage: node scripts/deploy.mjs <staging|production>");
  process.exit(1);
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
const wrangler = (...args) => run("npx", ["wrangler", ...args, "--env", env]);

run("npm", ["run", "catalog:sql"]);
wrangler("d1", "migrations", "apply", "DB", "--remote");
wrangler("d1", "execute", "DB", "--remote", "--yes", "--file", "dist/catalog.sql");
wrangler("deploy");
