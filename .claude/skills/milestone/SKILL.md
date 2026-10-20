---
name: milestone
description: Deliver one milestone from SPEC.md section 12 (M0–M7) end to end. Covers planning, approval, tests first, implementation, checks, review, and a PR into staging that is squash-merged when CI is green.
argument-hint: <milestone-id, e.g. M1>
disable-model-invocation: true
---

# Milestone $ARGUMENTS

Follow these steps in order. Do not skip a step or reorder them.

## 1. Read and branch

1. Read CLAUDE.md and SPEC.md in full. Find `$ARGUMENTS` in SPEC.md section 12. If it does not exist, stop and ask Bob.
2. Check that earlier milestones it depends on are merged into `staging`. If not, stop and say which are missing.
3. Make sure the working tree is clean, then run `git fetch origin staging` and `git checkout -b feat/<id>-<slug> origin/staging`, with a lowercase ID and a short slug, for example `feat/m1-auth`.

## 2. Plan, then wait

1. Use the built-in **Plan** agent. Give it the milestone text, the relevant SPEC.md sections, the CLAUDE.md rules, and the current repo layout. Ask for:
   - the files to add or change
   - the test cases, mapped to SPEC.md sections
   - the implementation steps
   - any migration or catalog change
   - any new dependency (it needs Bob's approval)
   - any dashboard step Bob will need to take
   - open questions or conflicts with SPEC.md
2. Show Bob the plan. **Stop and wait for his explicit approval.** Do not write any files until he approves. If he asks for changes, revise the plan and show it again.

## 3. Tests first

1. Run the **test-writer** agent with the approved plan and the SPEC.md sections it covers.
2. Check its report. The new tests must exist and fail for the right reason. Skip the failing-run check only for M0 if `package.json` does not exist yet, and have the scaffold make them runnable.
3. Commit the tests on the feature branch, staging the files in a separate command before `git commit`.

## 4. Implement

1. Implement the plan until the new tests pass. Follow CLAUDE.md:
   - the server is authoritative
   - game rules are pure functions
   - parameterized queries only
   - UTC epoch milliseconds
   - migrations are new files only
   - no catalog data goes into the client
2. Never edit a test to make it pass unless the test contradicts SPEC.md. If it does, explain that to Bob first.
3. If behavior has to differ from SPEC.md, stop and ask. If Bob agrees, update SPEC.md in this same PR.

## 5. Verify

1. Run `npm run check`, `npm test` and `npm run build`. All three must pass. Fix the code, never the tests, and repeat until they are clean.

## 6. Review

1. Save the diff with `git diff origin/staging...HEAD > "$(mktemp -t review-XXXX.diff)"` and note the absolute path.
2. Run the **reviewer** agent with that path and the milestone ID.
3. If the change touches auth, sessions, cookies, route protection, roles or secret handling, also run the **security-auditor** agent with the same path. **Always run it for M1.**
4. Fix every blocking, should-fix, critical, high and medium finding, then re-run verify and the agents that reported them.
5. If you decide not to fix a finding, list it in the PR description with the reason.

## 7. Pull request

1. Commit and run `git push -u origin <branch>`. The pre-commit hook scans for secrets and runs `npm test`. If the scan finds something, stop and tell Bob.
2. Open a PR into `staging` titled `<ID>: <summary>`. The body must have:
   - **What changed**
   - **How it was tested**: the commands run and the new test coverage
   - **Dashboard steps for Bob**: Cloudflare secrets or variables to set, or build settings to change. Write "None" if there are none. Never include secret values.
   - **Review**: reviewer and security-auditor verdicts, and any findings not fixed

## 8. CI and merge

1. Wait for the `ci` check on the latest commit. If it fails, read the logs, fix the code (never skip or weaken a test), verify locally, and push again. Repeat until it passes.
2. If the repository has no `ci` check yet (before M0 lands), stop and ask Bob instead of merging.
3. When `ci` is green, the PR is mergeable, and no review threads are open, **squash-merge** the PR into `staging`.
4. Tell Bob it is merged, and list any dashboard steps again.
5. For M0, remind him to confirm the staging deploy and `/api/health`, because the milestone is only done when staging deploys.
