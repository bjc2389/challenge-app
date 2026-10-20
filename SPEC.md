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
- Deploy command: `npm run deploy:<env>`. In order, it applies D1 migrations to the remote database, runs the catalog sync SQL there, then runs `wrangler deploy --env <env>`.
- Non-production branch builds are off.

**GitHub Actions** runs a job named `ci` on every pull request to `staging` or `main`: install, check, test, build, and a `wrangler deploy --dry-run` of both environments (`npm run verify:deploy`). Rulesets on both branches require `ci` to pass.

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
  - The client sends the user to `/login?next=<path>` whenever the API returns 401, except on `/login` and `/admin`, which show their own password form. After logging in it returns to that path if it is same-origin and not `/login` or `/admin`.
  - State-changing requests (anything but GET, HEAD and OPTIONS) whose `Origin` or `Sec-Fetch-Site` header shows another origin get 403.
- **Secrets:** an unset or empty secret, or a `SESSION_SECRET` shorter than 32 characters, counts as missing. The affected login and protected routes then return 500, and only the variable's name is logged.
- `/admin` is not linked anywhere in the UI.

## 4. Game lifecycle

States: `setup` → `rolled` → `active` → `finished` or `abandoned`.

**Create.** "New game" calls `POST /api/games` and returns a game code.

- The code is 5 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, regenerated if it collides with an existing code.
- The game URL is `/g/<code>`. Others join by entering the code on the home screen.

**Setup.** Enter two team names, then "Roll the dice."

- Names are 1–24 characters after trimming and must differ (ignoring case).
- Rolling picks the tasks and sets the status to `rolled`.

**Rolled.** The task list is visible so teams can gather supplies. Team names can still be edited. The big Start button sets `started_at`, sets `ends_at` to start plus 60 minutes, and moves the game to `active`.

**Active.** Any phone can mark or undo tasks for either team.

**End conditions:**

- **Completion:** a team completes the final task. The game becomes `finished` with that team as winner, `end_reason=completed`, and `ended_at` set to the completion time.
  - This must be a conditional write (only if the game is still active), so two simultaneous finishes produce exactly one winner.
- **Timeout:** the first request that touches the game at or after `ends_at` finalizes it. History endpoints also sweep and finalize expired games.
  - The team with the most completed tasks wins.
  - If tied, the team with the earlier last completion wins.
  - If still tied, the result is a tie with no winner.
  - `end_reason=timeout` and `ended_at=ends_at`.
- **Abandon:** allowed from `setup`, `rolled` or `active`, with a confirmation. The game gets no winner and is excluded from records.

There is no re-rolling, and the 60-minute limit is a constant in code.

## 5. Tasks and rolling

**Rolling**

- Each category's `countPerGame` sets how many tasks it contributes.
- The roll picks that many distinct active tasks at random, using crypto randomness, category by category in order. The final category always comes last.
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
- Completing a task that's already complete returns 200 and changes nothing.

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

**Sync**

- On every deploy, a script generates SQL that upserts all categories and tasks.
- Any database row that's missing from the file is marked inactive. Rows are never deleted.
- Staging gets catalog changes first, and production gets them on promotion.

## 8. Data model (D1)

- `categories`: id (text, primary key), name, sort_order, count_per_game, is_final, active
- `catalog_tasks`: id (text, primary key), category_id, text, active
- `games`: id, code (unique), status, is_test (default 0), version, created_at, rolled_at, started_at, ends_at, ended_at, end_reason, winner_team_id
- `teams`: id, game_id, slot (1 or 2), name
- `game_tasks`: id, game_id, catalog_task_id, category_id, text, sort_order, is_final
- `team_tasks`: team_id, game_task_id, completed_at (null when not done). Primary key is (team_id, game_task_id).
- `task_events`: id, game_id, team_id, game_task_id, action (`complete` or `undo`), at

Deleting a game deletes all of its child rows in one batch.

## 9. Screens

- **`/login`:** a password field.
- **`/` (home):** New game, Join by code, History.
- **`/g/:code` (game):**
  - *Setup:* two name fields and "Roll the dice."
  - *Rolled:* the task list, editable names, a big Start button, and Abandon.
  - *Active:*
    - The header shows the countdown and the score (tasks done per team).
    - The body is a grid: one row per task, with a checkbox column for each team.
    - The final row shows a lock for each team until it unlocks.
    - Tapping a checked box asks to confirm an undo.
    - There's a button to share the code or link, and Abandon (with confirmation).
  - *Over:* a result banner (winner, tie or abandoned), the final board, and a link to the game's history page.
- **`/history`:** finished and abandoned games, newest first, with abandoned games labeled. A records block shows:
  - fastest win
  - fastest puzzle (from a team's last non-final completion to its puzzle completion)
  - games played

  Records exclude abandoned games. Test games are hidden entirely.
- **`/history/:code`:** teams, result, end reason, duration, each team's split time per task (minutes from start), and the full event log including undos.
- **`/admin`:**
  - Admin login.
  - A games table showing code, date, status, teams, result and test flag. Each game can be marked or unmarked as a test, or deleted (with confirmation; this is a permanent delete).
  - A read-only view of the catalog.

## 10. API

- **Public:**
  - `POST /api/login`
  - `POST /api/logout`
  - `POST /api/admin/login`
  - `GET /api/health`, which returns `{ok, env}`
- **Player:**
  - `GET /api/session`, which returns `{role, exp}` for the current session
  - `POST /api/games`
  - `GET /api/games/:code`
  - `POST /api/games/:code/roll`
  - `PATCH /api/games/:code/teams`
  - `POST /api/games/:code/start`
  - `POST /api/games/:code/tasks/:id/complete`
  - `POST /api/games/:code/tasks/:id/undo`
  - `POST /api/games/:code/abandon`
  - `GET /api/history`
  - `GET /api/history/:code`
- **Admin:**
  - `GET /api/admin/games`
  - `PATCH /api/admin/games/:code` (sets `isTest`)
  - `DELETE /api/admin/games/:code`
  - `GET /api/admin/catalog`
- **Errors** return `{error, message}` with these status codes:
  - 401: not logged in
  - 403: wrong role
  - 404: not found
  - 409: invalid state change
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
