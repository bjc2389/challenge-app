---
name: promote
description: Promote staging to production. Opens a PR from staging into main that summarizes what changed since the last promotion, waits for Bob to say go, then merges with a merge commit once CI is green.
disable-model-invocation: true
---

# Promote staging to main

Only run this skill when Bob has asked to promote.

## 1. Work out what changed

1. Run `git fetch origin main staging`.
2. List what is in staging but not yet in main: `git log --oneline --first-parent origin/main..origin/staging`. Map each commit to its merged PR.
3. If the list is empty, tell Bob there is nothing to promote and stop.
4. Find the last promotion, the most recent merge of staging into main: `git log --merges --first-parent -1 origin/main`. Mention its date in the summary.
5. Check whether either of these changed in the range: `git diff --stat origin/main...origin/staging -- migrations/ catalog/`.

## 2. Open the PR

1. If an open PR from `staging` into `main` already exists, update its description instead of opening a new one.
2. Otherwise, open a PR with head `staging`, base `main`, and the title `Promote staging to production (<YYYY-MM-DD>)`.
3. The body must have:
   - **Since last promotion** (<date or "first promotion">): one line per merged PR, with its title and link
   - **Migrations**: new migration files, which run on the production D1 before the new code goes live. Write "None" if there are none.
   - **Catalog changes**: tasks added or retired. Write "None" if there are none.
   - **Dashboard steps for Bob**: production secrets, variables or build settings that must be in place before or after merging. Write "None" if there are none. Never include secret values.
   - **How it was tested**: the staging deploy, and CI on this PR

## 3. Stop and wait

1. Give Bob the PR link.
2. **Stop. Do not merge until Bob explicitly says "go"** (or clearly equivalent wording) in this conversation. Approval on an earlier promotion does not count.

## 4. Merge after "go"

1. Confirm that the `ci` check is green on the PR's latest commit and the PR is mergeable. If `ci` is red, do not merge. Investigate, and fix the code through a normal `fix/<name>` PR into `staging` rather than pushing to `staging` directly. Tell Bob.
2. Merge using a **merge commit** (merge method `merge`). Never squash or rebase, and never force-push.
3. Do not delete the `staging` branch. Turn off any "delete branch after merge" option.
4. Tell Bob it is merged. Cloudflare builds production from `main`, so list any dashboard steps again and suggest he check the production `/api/health`.
