// Scans the added lines of a unified diff for likely credentials.
// Used by guard-bash.mjs before every git commit; can also be run by hand:
//   node .claude/hooks/secret-scan.mjs          (scans the staged diff)
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// This file necessarily contains the patterns, so it is not scanned itself.
const SKIP_FILES = new Set([".claude/hooks/secret-scan.mjs"]);

const PATTERNS = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{50,}\b/],
  ["Slack token", /\bxox[abeprs]-[A-Za-z0-9-]{10,}/],
  ["Stripe key", /\b[rs]k_(live|test)_[A-Za-z0-9]{16,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI-style API key", /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/],
  ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["credentials in URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/@'"]{6,}@/i],
];

const KEYWORD = "(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential|auth[_-]?key)";
// name = "literal" / name: 'literal' / "name": "literal"
const QUOTED_ASSIGNMENT = new RegExp(`${KEYWORD}[A-Za-z0-9_-]*["']?\\s*[:=]\\s*(["'\`])([^"'\`]{8,})\\1`, "i");
// NAME=value lines as found in .env-style files
const ENV_ASSIGNMENT = new RegExp(`^\\s*(?:export\\s+)?[A-Z0-9_]*${KEYWORD}[A-Z0-9_]*\\s*=\\s*([^\\s#]{8,})`, "i");

// Values that are obviously not real credentials.
const PLACEHOLDER = /test|fake|example|dummy|placeholder|changeme|sample|not[-_]?a[-_]?real|redacted|xxxx|\*\*\*\*|<[^>]*>|\$\{|\$\(|process\.env|env\.|^(.)\1+$/i;

export function scanDiff(diff) {
  const findings = [];
  let file = null;
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "");
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      if (file && !SKIP_FILES.has(file)) {
        const kind = classify(raw.slice(1));
        if (kind) findings.push({ file, line, kind });
      }
      line++;
    } else if (!raw.startsWith("-")) {
      line++;
    }
  }
  return findings;
}

function classify(text) {
  for (const [kind, re] of PATTERNS) {
    if (re.test(text)) return kind;
  }
  const quoted = text.match(QUOTED_ASSIGNMENT);
  if (quoted && !PLACEHOLDER.test(quoted[2])) return "hard-coded secret assignment";
  const env = text.match(ENV_ASSIGNMENT);
  if (env && !PLACEHOLDER.test(env[1])) return "hard-coded secret assignment";
  return null;
}

// Values are never printed, only where they are.
export function formatFindings(findings) {
  return findings.map((f) => `  ${f.file}:${f.line}  (${f.kind})`).join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = spawnSync("git", ["diff", "--cached", "--no-color", "-U0"], { encoding: "utf8" });
  const findings = scanDiff(r.stdout || "");
  if (findings.length) {
    console.error(`Possible secrets in the staged diff:\n${formatFindings(findings)}`);
    process.exit(1);
  }
  console.log("No likely secrets in the staged diff.");
}
