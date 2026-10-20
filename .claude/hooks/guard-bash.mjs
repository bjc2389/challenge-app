// PreToolUse hook for Bash. Backs up the deny rules in settings.json, which only
// match a command's prefix, by parsing the whole command line. It blocks:
//   - wrangler deploy / secret / --remote (any launcher), and npm run deploy:*
//   - git push --force / -f / +refspec, and any push that targets main or staging
//   - committing, merging, cherry-picking, reverting or rebasing on main or staging
//   - shell writes to .dev.vars / .env files and to existing migrations
// Before every git commit it scans the staged diff for secrets, then runs npm test
// (skipped while package.json does not exist).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  PROTECTED_BRANCHES,
  block,
  currentBranch,
  git,
  isEnvFile,
  isExistingMigration,
  readHookInput,
  repoRoot,
} from "./lib.mjs";
import { formatFindings, scanDiff } from "./secret-scan.mjs";

const input = readHookInput();
const command = (input.tool_input && input.tool_input.command) || "";
const startCwd = input.cwd || process.cwd();

// ---------------------------------------------------------------------------
// Tokenizer: splits a command line into segments (separated by ; && || | & and
// newlines) of word tokens. Quotes are honored, heredoc bodies are skipped as
// data, and $(...) / backtick bodies are returned separately for re-analysis.
// ---------------------------------------------------------------------------
function tokenize(src) {
  const segments = [];
  const nested = [];
  let tokens = [];
  let word = null;
  let pendingHeredocs = [];
  let i = 0;

  const endWord = () => {
    if (word !== null) tokens.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  const readBalanced = (start) => {
    // src[start] is just after "$(" ; returns index after matching ")"
    let depth = 1;
    let j = start;
    while (j < src.length && depth > 0) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") depth--;
      j++;
    }
    nested.push(src.slice(start, j - 1));
    return j;
  };

  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      if (src[i + 1] !== "\n") word = (word ?? "") + src[i + 1];
      i += 2;
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j === -1 ? src.length : j;
      word = (word ?? "") + src.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      let buf = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          buf += src[j + 1];
          j += 2;
        } else if (src[j] === "$" && src[j + 1] === "(") {
          j = readBalanced(j + 2);
        } else if (src[j] === "`") {
          const k = src.indexOf("`", j + 1);
          const end = k === -1 ? src.length : k;
          nested.push(src.slice(j + 1, end));
          j = end + 1;
        } else {
          buf += src[j++];
        }
      }
      word = (word ?? "") + buf;
      i = j + 1;
    } else if (c === "$" && src[i + 1] === "(") {
      endWord();
      i = readBalanced(i + 2);
    } else if (c === "`") {
      endWord();
      const k = src.indexOf("`", i + 1);
      const end = k === -1 ? src.length : k;
      nested.push(src.slice(i + 1, end));
      i = end + 1;
    } else if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      // heredoc: remember the delimiter, skip the body at the next newline
      endWord();
      let j = i + 2;
      if (src[j] === "-") j++;
      while (src[j] === " " || src[j] === "\t") j++;
      const m = src.slice(j).match(/^(['"]?)([A-Za-z0-9_.-]+)\1/);
      if (m) {
        pendingHeredocs.push(m[2]);
        j += m[0].length;
      }
      i = j;
    } else if (c === "\n") {
      endSegment();
      i++;
      for (const delim of pendingHeredocs) {
        while (i < src.length) {
          const nl = src.indexOf("\n", i);
          const lineEnd = nl === -1 ? src.length : nl;
          const line = src.slice(i, lineEnd);
          i = lineEnd + 1;
          if (line.trim() === delim) break;
        }
      }
      pendingHeredocs = [];
    } else if (c === ";" || c === "|" || c === "&" || c === "(" || c === ")" || c === "{" || c === "}") {
      // "&>" and ">&" are redirects, not separators
      if (c === "&" && src[i + 1] === ">") {
        endWord();
        tokens.push(">");
        i += src[i + 2] === ">" ? 3 : 2;
      } else if ((c === "{" || c === "}") && word !== null) {
        word += c;
        i++;
      } else {
        endSegment();
        i++;
      }
    } else if (c === ">" || c === "<") {
      if (c === ">" && word !== null && /^\d$/.test(word)) word = null; // 2>file
      endWord();
      let j = i + 1;
      if (src[j] === ">" || src[j] === "|") j++;
      if (src[j] === "&") {
        // >&2 duplicates a descriptor; not a file write
        j++;
        while (/\d|-/.test(src[j] || "")) j++;
        i = j;
        continue;
      }
      tokens.push(c === ">" ? ">" : "<");
      i = j;
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else {
      word = (word ?? "") + c;
      i++;
    }
  }
  endSegment();
  return { segments, nested };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------
const WRAPPERS = new Set(["sudo", "env", "command", "exec", "time", "nice", "nohup", "builtin", "xargs"]);
const RUNNERS = new Set(["npx", "npm", "pnpm", "pnpx", "yarn", "bun", "bunx", "node"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const STAGING_SUBCOMMANDS = new Set(["add", "rm", "mv", "restore", "reset", "apply", "stage", "update-index"]);
const COMMIT_ON_PROTECTED = new Set(["commit", "merge", "cherry-pick", "revert", "am", "rebase"]);

const state = {
  cwd: startCwd,
  assumedBranch: new Map(), // repo root -> branch after a checkout/switch earlier in the command
  stagedEarlier: false,
  commits: [], // { dir, all, paths }
};

function commandWord(tokens) {
  let k = 0;
  while (k < tokens.length) {
    const t = tokens[k];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) k++;
    else if (WRAPPERS.has(path.basename(t))) {
      k++;
      while (k < tokens.length && tokens[k].startsWith("-")) k++;
    } else break;
  }
  return k;
}

function branchOf(dir) {
  const root = repoRoot(dir);
  if (root && state.assumedBranch.has(root)) return state.assumedBranch.get(root);
  return currentBranch(dir);
}

function analyze(src, depth = 0) {
  if (depth > 5) return;
  const { segments, nested } = tokenize(src);
  for (const seg of segments) analyzeSegment(seg, depth);
  for (const body of nested) analyze(body, depth + 1);
}

function analyzeSegment(tokens, depth) {
  checkRedirects(tokens);
  const k = commandWord(tokens);
  if (k >= tokens.length) return;
  const cmd = path.basename(tokens[k]);
  const args = tokens.slice(k + 1);

  if (cmd === "cd") {
    const target = args.find((a) => !a.startsWith("-"));
    if (target && !target.includes("$")) state.cwd = path.resolve(state.cwd, target.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
    return;
  }
  if ((SHELLS.has(cmd) && args.includes("-c")) || cmd === "eval") {
    const body = cmd === "eval" ? args.join(" ") : args[args.indexOf("-c") + 1];
    if (body) analyze(body, depth + 1);
    return;
  }
  if (cmd === "wrangler" || /^wrangler(@|$)/.test(cmd)) return checkWrangler(args);
  if (RUNNERS.has(cmd)) return checkRunner(args);
  if (cmd === "git") return checkGit(args);
  checkFileWrites(cmd, args);
}

function checkWrangler(args) {
  for (const a of args) {
    if (a === "deploy" || a === "secret" || a === "--remote" || a.startsWith("--remote=")) {
      block(
        `wrangler ${a} touches remote Cloudflare resources. Only Cloudflare builds deploy or manage secrets; ` +
          "tell Bob which dashboard setting to change instead.",
      );
    }
  }
}

function checkRunner(args) {
  const w = args.findIndex((a) => /^(.*\/)?wrangler(@[^/]*)?$/.test(a));
  if (w !== -1) checkWrangler(args.slice(w + 1));
  if (args.some((a) => /^deploy(:|$)/.test(a))) {
    block("deploy scripts are run only by Cloudflare builds. Never run them yourself.");
  }
}

function checkGit(args) {
  let dir = state.cwd;
  let k = 0;
  while (k < args.length && args[k].startsWith("-")) {
    const opt = args[k];
    if (opt === "-C") {
      dir = path.resolve(dir, args[k + 1] || ".");
      k += 2;
    } else if (opt === "-c" || opt === "--git-dir" || opt === "--work-tree" || opt === "--namespace") k += 2;
    else k++;
  }
  const sub = args[k];
  const rest = args.slice(k + 1);
  if (!sub) return;

  if (sub === "push") return checkPush(dir, rest);
  if (sub === "checkout" || sub === "switch") return trackCheckout(dir, sub, rest);
  if (STAGING_SUBCOMMANDS.has(sub)) {
    state.stagedEarlier = true;
    if (sub === "rm" || sub === "mv") checkPaths(rest.filter((a) => !a.startsWith("-")), dir);
    return;
  }
  if (sub === "pull") {
    const branch = branchOf(dir);
    if (PROTECTED_BRANCHES.has(branch) && !rest.includes("--ff-only")) {
      block(`git pull on ${branch} can create a merge commit. Use "git pull --ff-only" to update ${branch}.`);
    }
    return;
  }
  if (COMMIT_ON_PROTECTED.has(sub)) {
    const branch = branchOf(dir);
    const harmless = rest.includes("--abort") || (sub === "merge" && rest.includes("--ff-only"));
    if (PROTECTED_BRANCHES.has(branch) && !harmless) {
      block(`never commit on ${branch} (git ${sub}). Create a feat/<name> or fix/<name> branch from staging first.`);
    }
    if (sub === "commit") queueCommit(dir, rest);
  }
}

function trackCheckout(dir, sub, rest) {
  const root = repoRoot(dir);
  if (!root) return;
  const createFlag = sub === "checkout" ? /^-[bB]$/ : /^-[cC]$|^--create$|^--force-create$/;
  const f = rest.findIndex((a) => createFlag.test(a));
  if (f !== -1 && rest[f + 1]) {
    state.assumedBranch.set(root, rest[f + 1]);
    return;
  }
  const dd = rest.indexOf("--");
  const positional = (dd === -1 ? rest : rest.slice(0, dd)).filter((a) => !a.startsWith("-"));
  const target = positional[0];
  if (target && git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${target}`]).ok) {
    state.assumedBranch.set(root, target);
  } else if (target && git(root, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${target}`]).ok) {
    state.assumedBranch.set(root, target);
  }
}

const PUSH_OPTS_WITH_VALUE = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);

function checkPush(dir, args) {
  const positional = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--") {
      positional.push(...args.slice(k + 1));
      break;
    }
    if (a.startsWith("--")) {
      if (a === "--force" || a.startsWith("--force-with-lease") || a === "--force-if-includes") {
        block("force-pushing is never allowed. Push a new commit instead.");
      }
      if (a === "--mirror" || a === "--all" || a === "--branches") {
        block(`git push ${a} would push main and staging. Push your feature branch by name.`);
      }
      if (PUSH_OPTS_WITH_VALUE.has(a)) k++;
    } else if (a.startsWith("-") && a.length > 1) {
      if (/^-[a-zA-Z]*f/.test(a)) block("force-pushing is never allowed. Push a new commit instead.");
      if (PUSH_OPTS_WITH_VALUE.has(a)) k++;
    } else {
      positional.push(a);
    }
  }
  const refspecs = positional.slice(1);
  if (refspecs.length === 0) {
    const branch = branchOf(dir);
    if (PROTECTED_BRANCHES.has(branch)) {
      block(`you are on ${branch}; a bare git push would push to it directly. Changes reach ${branch} only through a pull request.`);
    }
    return;
  }
  for (const spec of refspecs) {
    if (spec.startsWith("+")) block("force-pushing (+refspec) is never allowed.");
    const parts = spec.split(":");
    let dst = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    if (dst === "HEAD" || dst === "@") dst = branchOf(dir);
    dst = (dst || "").replace(/^refs\/heads\//, "");
    if (PROTECTED_BRANCHES.has(dst)) {
      block(`pushing directly to ${dst} is not allowed. Open a pull request into ${dst} instead.`);
    }
  }
}

const COMMIT_OPTS_WITH_VALUE = new Set([
  "-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message",
  "--author", "--date", "-t", "--template", "--fixup", "--squash", "--cleanup", "--trailer",
  "-S", "--gpg-sign", "--pathspec-from-file",
]);

function queueCommit(dir, args) {
  let all = false;
  const paths = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--") {
      paths.push(...args.slice(k + 1));
      break;
    }
    const shortFlags = /^-[a-zA-Z]+$/.test(a);
    if (a === "--all" || (shortFlags && a.includes("a"))) all = true;
    if (COMMIT_OPTS_WITH_VALUE.has(a) || (shortFlags && "mFCct".includes(a[a.length - 1]))) k++;
    else if (!a.startsWith("-")) paths.push(a);
  }
  state.commits.push({ dir, all, paths, stagedBefore: state.stagedEarlier });
}

// ---------------------------------------------------------------------------
// Protected files written from the shell
// ---------------------------------------------------------------------------
function checkPaths(paths, dir = state.cwd) {
  for (const p of paths) {
    if (!p || p.startsWith("-")) continue;
    if (isEnvFile(p)) block(`${p} holds local secrets and must not be modified by Claude.`);
    if (isExistingMigration(p, dir)) block(`${p} is an existing migration and must not be modified. Add a new migration file.`);
  }
}

function checkRedirects(tokens) {
  const targets = [];
  tokens.forEach((t, k) => {
    if (t === ">" && tokens[k + 1]) targets.push(tokens[k + 1]);
  });
  checkPaths(targets);
}

function checkFileWrites(cmd, args) {
  const operands = args.filter((a) => !a.startsWith("-"));
  switch (cmd) {
    case "tee":
    case "rm":
    case "mv":
    case "truncate":
    case "shred":
    case "unlink":
      return checkPaths(operands);
    case "cp":
    case "ln":
    case "install":
    case "rsync":
      return checkPaths(operands.slice(-1));
    case "sed":
    case "perl":
      if (args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"))) return checkPaths(operands);
      return;
    case "dd":
      return checkPaths(args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3)));
    default:
  }
}

// ---------------------------------------------------------------------------
// Pre-commit checks
// ---------------------------------------------------------------------------
function preCommit({ dir, all, paths, stagedBefore }) {
  if (stagedBefore) {
    block(
      "stage files in a separate command before running git commit, so the staged diff can be " +
        "scanned for secrets first (e.g. run `git add ...`, then `git commit ...`).",
    );
  }
  const root = repoRoot(dir);
  if (!root) return;

  const diffArgs = all || paths.length ? ["diff", "HEAD", "--no-color", "-U0"] : ["diff", "--cached", "--no-color", "-U0"];
  if (paths.length) diffArgs.push("--", ...paths);
  let diff = git(root, diffArgs);
  if (!diff.ok && (all || paths.length)) diff = git(root, ["diff", "--cached", "--no-color", "-U0"]); // no HEAD yet
  const findings = scanDiff(diff.out);
  if (findings.length) {
    block(
      `possible secrets in the diff being committed:\n${formatFindings(findings)}\n` +
        "Stop and tell Bob. Do not commit, and do not print the values.",
    );
  }

  if (!existsSync(path.join(root, "package.json"))) return;
  const test = spawnSync("npm", ["test"], { cwd: root, encoding: "utf8", timeout: 540_000 });
  if (test.status !== 0) {
    const output = `${test.stdout || ""}${test.stderr || ""}`.trim().split("\n").slice(-40).join("\n");
    block(`npm test failed, so the commit was stopped. Fix the code (never weaken a test).\n${output}`);
  }
}

analyze(command);
for (const c of state.commits) preCommit(c);
process.exit(0);
