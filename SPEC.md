# Challenge App — MVP spec

## 1. Overview

- Two teams race through the same randomly rolled task list.
- The final task, a puzzle, stays locked until a team finishes everything else.
- The first team to finish wins. Games are capped at 60 minutes.
- Played on phones. Any phone can mark tasks for either team, on the honor system.

## 2. Environments

| | Staging | Production |
|---|---|---|
| Branch | `staging` | `main` |
| Worker | `challenge-app-staging` | `challenge-app-production` |
| D1 | `challenge-app-staging-db` | `challenge-app-production-db` |

- Each environment has its own `PLAYER_PASSWORD`, `ADMIN_PASSWORD` and `SESSION_SECRET`.
- A non-secret variable, `APP_ENV`, holds the environment name.
- Both run the same code and the same catalog file, and both use workers.dev URLs.

**Cloudflare build settings (per Worker)**

- Build command: `npm ci && npm run check && npm test && npm run build`
- Deploy command: `npm run deploy:<env>`. In order, it validates the catalog and generates the sync SQL locally, applies D1 migrations to the remote database, runs the catalog sync SQL there, then runs `wrangler deploy --env <env>`. Any failing step stops the deploy.
- The build's API token needs **Account → D1 → Edit** for the migration and sync steps.
- Non-production branch builds are off.

**GitHub Actions** runs a job named `ci` on every pull request to `staging` or `main`: install, check, test, build, and a `wrangler deploy --dry-run` of both environments (`npm run verify:deploy`), then `npm run db:local` twice to prove the migrations and catalog sync apply cleanly and repeat without changes. Rulesets on both branches require `ci` to pass.

## 3. Auth

- **Player login:** `POST /api/login` compares the submitted password to `PLAYER_PASSWORD` using a constant-time comparison.
  - On success, it sets a cookie named `session`: HttpOnly, Secure, SameSite=Lax, Path=/, lasting 30 days. The cookie holds `{role, exp}`, signed with HMAC-SHA256 using `SESSION_SECRET`.
    - Format: `base64url(JSON {role, exp})` + `.` + `base64url(HMAC of the first part)`, with `exp` in UTC epoch milliseconds.
    - Expiry is fixed at login and never extended by activity.
  - On failure, it returns 401 after a delay of about one second.
- **Admin login:** `POST /api/admin/login` checks `ADMIN_PASSWORD` and sets an admin session lasting 12 hours, with the same failure delay. An admin session also grants player access. Admin and player sessions share the one cookie, so when an admin session expires the user is logged out entirely.
- **Logout:** `POST /api/logout` always clears the cookie, with or without a session. Sessions are stateless, so a copied cookie stays valid until it expires; changing `SESSION_SECRET` is the way to end every session.
- **What's protected:** every `/api/*` route requires a session, except `POST /api/login`, `POST /api/logout`, `POST /api/admin/login` and `GET /api/health`.
  - No valid session returns 401. A player session on `/api/admin` or `/api/admin/*` returns 403.
  - Static files and the app shell are public because they contain no data.
  - The client sends the user to `/login?next=<path>` whenever the API returns 401, except on `/login` and `/admin`, which show their own password form. After logging in it returns to that path if it is same-origin and not `/login` or `/admin`. Both steps replace the current history entry, so Back never lands on a page that redirects again.
  - State-changing requests (anything but GET, HEAD and OPTIONS) whose `Origin` or `Sec-Fetch-Site` header shows another origin get 403.
- **Headers:** every `/api` response, errors included, has `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`. Static files get a Content-Security-Policy that allows only the app's own files and Google Fonts, plus nosniff, a same-origin referrer policy, no framing and `noindex`, from `public/_headers`.
- **Secrets:** an unset or empty secret, or a `SESSION_SECRET` shorter than 32 characters, counts as missing. The affected login and protected routes then return 500, and only the variable's name is logged.
- `/admin` is not linked anywhere in the UI.

## 4. Game lifecycle

States: `setup` → `rolled` → `active` → `finished` or `abandoned`.

**Create.** "New game" calls `POST /api/games` and returns a game code.

- The code is 5 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, regenerated if it collides with an existing code.
- The game URL is `/g/<code>`. Others join by entering the code on the home screen. Codes are case-insensitive.
- A new game starts in `setup` with two teams named "Team 1" and "Team 2".

**Setup.** Enter two team names, then "Roll the dice."

- Names are 1–24 characters after trimming, with no control characters, and must differ (ignoring case).
- Saving names identical to the current ones changes nothing.
- Rolling picks the tasks and sets the status to `rolled`.

**Rolled.** The task list is visible so teams can gather supplies. Team names can still be edited. The big Start button sets `started_at`, sets `ends_at` to start plus 60 minutes, and moves the game to `active`.

**Active.** Any phone can mark or undo tasks for either team.

**End conditions:**

- **Completion:** a team completes the final task. The game becomes `finished` with that team as winner, `end_reason=completed`, and `ended_at` set to the completion time.
  - This must be a conditional write (only if the game is still active), so two simultaneous finishes produce exactly one winner.
- **Timeout:** the first request that touches the game at or after `ends_at` finalizes it, including a plain `GET`. Both history endpoints first sweep and finalize expired games, up to 5 per request (the rest on the next request); the detail endpoint also finalizes its own game.
  - The team with the most completed tasks wins.
  - If tied, the team with the earlier last completion wins.
  - If still tied, the result is a tie with no winner.
  - `end_reason=timeout` and `ended_at=ends_at`.
- **Abandon:** allowed from `setup`, `rolled` or `active`, with a confirmation. `ended_at` is set to the abandon time, so history can sort it. The game gets no winner and no end reason, and is excluded from records.

There is no re-rolling, and the 60-minute limit is a constant in code.

## 5. Tasks and rolling

**Rolling**

- Each category's `countPerGame` sets how many tasks it contributes.
- The roll picks that many distinct active tasks at random, using crypto randomness, category by category in order. The final category always comes last. Tasks within a category come in random order.
- The catalog is read from D1 at roll time. If an active category has fewer active tasks than its `countPerGame`, or there isn't exactly one active final category with `countPerGame` 1, the roll fails with 409 `catalog_incomplete` (naming the short category when there is one), and the game stays in `setup`.
- Task text is copied into the game when rolled, so later catalog edits never change existing games.
- Both teams get the same list.

**Order and the puzzle lock**

- Non-final tasks can be done in any order.
- The final task is locked for a team until all of that team's other tasks are complete. The server enforces this.
- Undoing a task relocks the final task.

**Complete and undo**

- Endpoints: `POST /api/games/:code/tasks/:taskId/complete` and `.../undo`, with body `{teamId}`.
- Both are allowed only while the game is active and before `ends_at`.
- Undo requires a confirmation in the UI. The final task can't be undone, because completing it ends the game.
- Each complete or undo also writes a `task_events` row. The state change and the event go in a single D1 batch.
- Completing a task that's already complete returns 200 and changes nothing. So does undoing a task that isn't complete.
- `teamId` is the team's `id` from the game view. A team from another game returns 422; a task from another game returns 404.
- Completing the final task while it's locked returns 409 `final_locked`. Undoing it returns 409 `final_not_undoable`.

## 6. Live updates and timer

- The game screen polls `GET /api/games/:code` every 3 seconds while the page is visible. Polling pauses when the page is hidden and stops when the game is over.
- Each response includes:
  - `serverNow`: the client uses it to correct for clock drift and counts down to `ends_at`.
  - `version`: it increments on every write, so the client can skip redrawing when nothing changed.
- The client never decides that the game has ended. At 0:00 it shows "Time!" and keeps polling until the server reports the final state.

## 7. Catalog (managed in the repo)

`catalog/catalog.json` is the only source of truth for categories, per-game counts and tasks. The admin page shows it read-only.

```json
{
  "categories": [
    { "id": "beer", "name": "Beer", "order": 1, "countPerGame": 1 },
    { "id": "tough-drink", "name": "Tough Drink", "order": 2, "countPerGame": 2 },
    { "id": "food", "name": "Food Challenge", "order": 3, "countPerGame": 1 },
    { "id": "cognitive", "name": "Cognitive", "order": 4, "countPerGame": 1 },
    { "id": "puzzle", "name": "Final Puzzle", "order": 5, "countPerGame": 1, "final": true }
  ],
  "tasks": [
    { "id": "beer-case-24", "category": "beer", "text": "Finish a 24-can case" },
    { "id": "four-loko", "category": "tough-drink", "text": "Four Loko" },
    { "id": "natty-daddy", "category": "tough-drink", "text": "Natty Daddy" },
    { "id": "syrup-challenge", "category": "food", "text": "Syrup challenge (TBD)" },
    { "id": "banana-challenge", "category": "food", "text": "Banana challenge (TBD)" },
    { "id": "word-search", "category": "cognitive", "text": "Complete a word search" },
    { "id": "puzzle-250", "category": "puzzle", "text": "250-piece puzzle" },
    { "id": "puzzle-500", "category": "puzzle", "text": "500-piece puzzle" }
  ]
}
```

**Validation.** A test checks these rules, so a bad catalog fails CI:

- IDs are unique and kebab-case.
- Every task's category exists.
- Exactly one category is final, and its `countPerGame` is 1.
- Every `countPerGame` is at least 1.
- Every category has at least `countPerGame` active tasks.
- Structure:
  - The file is an object with non-empty `categories` and `tasks` arrays.
  - Unknown keys are rejected at every level, so a typo can't slip through.
  - Required fields are non-empty strings, and `order` and `countPerGame` are integers.
  - `order` is unique.
  - `final` (categories) and `active` (tasks) are booleans when present.
  - `name` and `text` are at most 200 characters, with no control characters or newlines.
- Only tasks take `"active": false`. A category is retired by removing it from the file.

**Sync**

- On every deploy, `npm run catalog:sql` validates the file and generates SQL that upserts all categories and tasks. An invalid file stops the deploy before anything remote runs.
- Any database row that's missing from the file is marked inactive. Rows are never deleted.
- The app reads the catalog from D1 only. Neither the Worker nor the client imports the file.
- Staging gets catalog changes first, and production gets them on promotion.

## 8. Data model (D1)

- `categories`: id (text, primary key), name, sort_order, count_per_game, is_final, active
- `catalog_tasks`: id (text, primary key), category_id, text, active
- `games`: id, code (unique), status, is_test (default 0), version, created_at, rolled_at, started_at, ends_at, ended_at, end_reason, winner_team_id
- `teams`: id, game_id, slot (1 or 2), name
- `game_tasks`: id, game_id, catalog_task_id, category_id, text, sort_order, is_final
- `team_tasks`: team_id, game_task_id, completed_at (null when not done). Primary key is (team_id, game_task_id).
- `task_events`: id, game_id, team_id, game_task_id, action (`complete` or `undo`), at

- `games`, `teams`, `game_tasks` and `task_events` use integer IDs. The game `code` is the public ID.
- `status` is one of the §4 states. `end_reason` is `completed` or `timeout` once a game is finished, and null otherwise, including for abandoned games. `winner_team_id` is null unless the game is finished, and stays null on a tie. The database enforces both rules.
- There is no `ON DELETE CASCADE`. Deleting a game deletes all of its child rows in one batch, in this order:
  1. clear `games.winner_team_id`;
  2. delete `task_events`;
  3. delete `team_tasks`;
  4. delete `game_tasks`;
  5. delete `teams`;
  6. delete the `games` row.

## 9. Screens

- **`/login`:** a password field.
- **`/` (home):** New game, Join by code (accepts lowercase, spaces or a pasted link), History, and a small Log out link. If the last game this phone opened is still in progress, a Resume button returns to it.
- **`/g/:code` (game):**
  - Every stage before the end shows the game code with a Share button (the phone's share sheet, or copy link) and Abandon (with confirmation).
  - *Setup:* two name fields and "Roll the dice."
  - *Rolled:* the task list, editable names, a big Start button, and Abandon. On phones that are watching when the dice are rolled, the tasks appear one by one, with the final puzzle last (no animation with reduced motion).
  - *Active:*
    - The header shows the countdown and the score (tasks done per team).
    - The body is a grid: one row per task, with a checkbox column for each team.
    - The final row shows a lock for each team until it unlocks.
    - Tapping a checked box asks to confirm an undo.
    - The countdown runs on the server's clock. At zero it shows "Time!", disables taps and waits for the server's result.
    - Phones that support it keep the screen awake during the game.
  - *Over:* a result banner (winner, tie or abandoned), the final board, and a link to the game's history page.
- **`/history`:** finished and abandoned games, newest first, with abandoned games labeled. Each shows the date, the score ("Reds 4 – 3 Blues"), the result and how long it took. The list shows the newest 25 games, with a note when there are more. A records block shows:
  - **fastest win:** the shortest game won by solving the puzzle (timeout wins always last the full hour, so they don't count);
  - **fastest puzzle:** from a team's last non-final completion to its puzzle completion, using the final state (after an undo and redo, the redo counts);
  - **games played:** finished games, including timeouts and ties.

  Records cover every game, not just the 25 listed. Ties go to whoever set the time first. Records exclude abandoned games. Test games are hidden entirely.
- **`/history/:code`:** teams, result, end reason, duration, each team's split time per task (minutes:seconds from start; undone tasks show "—"), the winner's puzzle time, and the full event log including undos. Games in progress and test games show "not found".
- Times on history screens are shown as `m:ss`.
- Unknown paths show a not-found page. An unexpected error while showing a page shows "Something went wrong" with Reload and Home, never a blank screen.
- **`/admin`:**
  - Admin login.
  - A games table showing every game, test and in-progress games included, newest created first: code (linking to the game), created date, status, teams, result and test flag. Each game can be marked or unmarked as a test, or deleted (with confirmation; this is a permanent delete). Deleting a game in progress is allowed, and the confirmation warns that anyone playing it will lose it.
  - A read-only view of the catalog, inactive categories and tasks included and shown muted. Active categories come first, each group in catalog order; tasks are ordered by id.

## 10. API

- **Public:**
  - `POST /api/login`
  - `POST /api/logout`
  - `POST /api/admin/login`
  - `GET /api/health`, which returns `{ok, env}`
- **Player:**
  - `GET /api/session`, which returns `{role, exp}` for the current session
  - `POST /api/games` (no body; returns 201)
  - `GET /api/games/:code`
  - `POST /api/games/:code/roll`
  - `PATCH /api/games/:code/teams`, with body `{team1, team2}`
  - `POST /api/games/:code/start`
  - `POST /api/games/:code/tasks/:id/complete`, with body `{teamId}`
  - `POST /api/games/:code/tasks/:id/undo`, with body `{teamId}`
  - `POST /api/games/:code/abandon`
  - `GET /api/history` returns `{items, hasMore, records}`:
    - `items`: up to 25 of `{code, status, startedAt, endedAt, elapsedMs, endReason, winnerTeamId, teams: [{id, slot, name, score}]}`;
    - `records`: `fastestWin` and `fastestPuzzle` are `{code, teamName, ms, endedAt}` or null; `gamesPlayed` is a number.
  - `GET /api/history/:code` returns `{game, teams, tasks, events}`:
    - `game`: `{code, status, createdAt, startedAt, endsAt, endedAt, endReason, winnerTeamId, elapsedMs}`;
    - `teams`: `[{id, slot, name, score, puzzleMs}]`;
    - `tasks`: `[{id, sortOrder, categoryName, text, isFinal, splitMs: [slot 1, slot 2]}]`;
    - `events`: `[{id, at, sinceStartMs, teamId, taskId, action}]`, ordered by time.
    - It returns 404 for unknown, test and in-progress games.
- **Game view.** Every `/api/games` endpoint above returns the whole game on success:
  ```
  { serverNow, version,
    game: { code, status, createdAt, rolledAt, startedAt, endsAt, endedAt, endReason, winnerTeamId, durationMs },
    teams: [{ id, slot, name, score, finalUnlocked, lastCompletedAt }],          // 2 teams, by slot
    tasks: [{ id, sortOrder, categoryId, categoryName, text, isFinal, completedAt: [slot 1, slot 2] }] }
  ```
  - Times are UTC epoch ms or null. `tasks` is empty before the roll, and `completedAt` is null while a task isn't done.
  - `version` goes up by exactly 1 on every change. Requests that change nothing don't bump it.
  - Finished and abandoned games still return their full state.
- **Admin:**
  - `GET /api/admin/games` returns `{items}`: every game, newest created first, as `{code, status, isTest, createdAt, startedAt, endedAt, endReason, winnerTeamId, elapsedMs, teams: [{id, slot, name, score}]}`. Like history, it first finalizes games whose time ran out.
  - `PATCH /api/admin/games/:code`, with body exactly `{isTest}` (a boolean), returns the updated game in the same shape. The test flag isn't game state, so it doesn't bump the game's `version`.
  - `DELETE /api/admin/games/:code` returns `{ok: true}` after deleting the game and all its rows (§8).
  - `GET /api/admin/catalog` returns `{categories: [{id, name, order, countPerGame, final, active, tasks: [{id, text, active}]}]}`, inactive entries included.
  - Unknown games return 404.
- **Errors** return `{error, message}` with these status codes:
  - 401: not logged in
  - 403: wrong role
  - 404: not found
  - 409: invalid state change. The `error` code says which:
    - `invalid_state`: the action isn't allowed in the current status (including re-rolling);
    - `game_over`: the game is finished, abandoned or out of time;
    - `final_locked` and `final_not_undoable` (§5);
    - `catalog_incomplete` (§5);
    - `busy`: the game kept changing during the request; try again.
  - 422: validation error
  - 500: server error, including a missing secret (`{error: "internal", message: "Something went wrong"}`, never with details)

## 11. Not in the MVP

- Player identities and team stats across games
- WebSockets
- Photo proof
- Re-rolls
- A configurable timer
- A custom domain
- Editing the catalog in the UI

## 12. Milestones

Each milestone is one pull request into `staging`.

- **M0:** Scaffold, CI, wrangler environments, deploy scripts, and `/api/health`. Done when staging deploys and the health check responds.
- **M1:** Player and admin auth, with tests.
- **M2:** Migrations, `catalog.json`, the validation test, and catalog sync.
- **M3:** Game API and rules: create, roll, start, complete/undo, finalize, abandon. Heavy test coverage on winner and lock logic.
- **M4:** Game UI: home, setup, roll reveal, scoreboard, timer, polling.
- **M5:** History and records.
- **M6:** Admin page.
- **M7:** Polish, then promote to production.
