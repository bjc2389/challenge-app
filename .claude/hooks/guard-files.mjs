// PreToolUse hook for Edit|Write|MultiEdit|NotebookEdit.
// Blocks edits to local secret files and to migrations that already exist.
import { block, isEnvFile, isExistingMigration, readHookInput } from "./lib.mjs";

const input = readHookInput();
const toolInput = input.tool_input || {};
const filePath = toolInput.file_path || toolInput.notebook_path;
const cwd = input.cwd || process.cwd();

if (filePath) {
  if (isEnvFile(filePath)) {
    block(
      `${filePath} holds local secrets and must not be edited by Claude. ` +
        "Edit .dev.vars.example (names with empty values) instead, and ask Bob to fill in his own .dev.vars.",
    );
  }
  if (isExistingMigration(filePath, cwd)) {
    block(
      `${filePath} is an existing migration. Applied migrations are never edited; ` +
        "create a new numbered migration file instead.",
    );
  }
}
process.exit(0);
