---
name: add-task
description: Add a task to, or retire a task from, the catalog in catalog/catalog.json. Runs the catalog validation test and opens a PR into staging.
argument-hint: <add|retire> <details, e.g. "add food: Hot sauce challenge" or "retire four-loko">
disable-model-invocation: true
---

# Catalog change: $ARGUMENTS

A catalog change edits `catalog/catalog.json` **only**. No other file changes in this PR.

## 1. Prepare

1. Read CLAUDE.md ("Database and catalog") and SPEC.md section 7.
2. If `catalog/catalog.json` or the catalog validation test does not exist yet (before M2), stop and tell Bob.
3. Make sure the working tree is clean, then run `git fetch origin staging` and `git checkout -b feat/catalog-<slug> origin/staging`.

## 2. Edit `catalog/catalog.json`

**Adding a task**
- The category must already exist. Adding a category is a bigger change, so ask Bob first.
- Choose a new, stable, kebab-case `id` (`^[a-z0-9]+(-[a-z0-9]+)*$`). It must not match any current ID, or any ID in the file's git history (`git log -p -- catalog/catalog.json`). IDs are never reused.
- Set `category` and `text`. Keep the text short, and include no real names or private details.
- Keep the existing formatting and order. Add the task next to the other tasks in its category.

**Retiring a task**
- Never rename or reuse an ID.
- Set `"active": false` on the task by default. Remove it entirely only if Bob asks. Either way, sync marks it inactive in the database and never deletes rows.
- Check that its category still has at least `countPerGame` active tasks. If it would not, stop and tell Bob.

## 3. Validate

1. Run the catalog validation test, for example `npx vitest run <catalog validation test file>`. Find it under `test/`.
2. Run the full `npm test`.
3. Both must pass. If validation fails, fix the catalog entry, never the test.
4. Run `git diff --stat` and confirm that `catalog/catalog.json` is the only changed file.

## 4. Pull request

1. Stage the file, then commit in a separate command, for example `catalog: add <id>` or `catalog: retire <id>`. Then run `git push -u origin <branch>`.
2. Open a PR into `staging`. The body must have:
   - **What changed**: the task ID, category and text, and whether it was added or retired
   - **How it was tested**: the validation test and `npm test`
   - **Dashboard steps for Bob**: None. Catalog sync runs on deploy, and production gets the change on the next promotion.
3. Do not merge the PR. Give Bob the link.
