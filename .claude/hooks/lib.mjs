// Shared helpers for the Claude Code hooks in this directory.
// No dependencies: these run with plain Node before package.json exists.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const PROTECTED_BRANCHES = new Set(["main", "staging"]);

export function readHookInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

// Exit code 2 blocks the tool call and shows stderr to Claude.
export function block(message) {
  process.stderr.write(`Blocked by project hook: ${message}\n`);
  process.exit(2);
}

export function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

export function repoRoot(dir) {
  const r = git(dir, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.out : null;
}

export function currentBranch(dir) {
  const r = git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return r.ok ? r.out : null;
}

// .dev.vars, .dev.vars.<env>, .env, .env.<anything>; the *.example templates are allowed.
export function isEnvFile(filePath) {
  const base = path.basename(filePath);
  if (base === ".dev.vars.example" || base === ".env.example") return false;
  return base === ".dev.vars" || base === ".env" || base.startsWith(".dev.vars.") || base.startsWith(".env.");
}

// True when filePath is an already-existing file inside <repo>/migrations/.
export function isExistingMigration(filePath, cwd) {
  const abs = path.resolve(cwd, filePath);
  const root = repoRoot(path.dirname(abs)) || repoRoot(cwd);
  if (!root) return false;
  const rel = path.relative(root, abs).split(path.sep).join("/");
  return rel.startsWith("migrations/") && existsSync(abs);
}
