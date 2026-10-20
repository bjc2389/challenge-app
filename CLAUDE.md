# Challenge App — instructions for Claude

This is a two-team party race game for a small group of friends. **SPEC.md is the source of truth.** Read it before any feature work. If a request conflicts with SPEC.md, stop and ask. If behavior changes, update SPEC.md in the same pull request.

## Stack

- TypeScript (strict), with Cloudflare Workers serving both static assets and the API
- Hono for the API, Vite + Preact for the frontend, D1 for the database
- Vitest with `@cloudflare/vitest-pool-workers` for tests
- Add no new runtime dependencies without asking Bob

## Commands

- `npm run dev`: run the app locally
- `npm run check`: typecheck and lint
- `npm test`
- `npm run build`: build the client
- `npm run verify:deploy`: dry-run both deploy configs (CI runs this; it needs no credentials)
- `npm run catalog:sql`: generate the catalog sync SQL
- `npm run deploy:staging` and `npm run deploy:production`: only Cloudflare builds run these. Never run them yourself.

## Layout

- `src/worker/`: API, auth, database access
- `src/worker/game/`: game rules as pure functions with no I/O
- `src/client/`: Preact app
- `migrations/`: numbered D1 migrations
- `catalog/catalog.json`: the task catalog (source of truth)
- `scripts/`: build helpers
- `test/`: tests

## Branches and merging

- Never commit directly to `main` or `staging`.
- Branch from `staging` using `feat/<name>` or `fix/<name>`.
- Each pull request covers one change or one milestone and targets `staging`. Squash-merge once CI is green.
- To promote, open a pull request from `staging` into `main`. Use a merge commit, not a squash. Do this only when Bob says to promote, and merge only once CI is green.
- Never force-push, rewrite history, or delete `main` or `staging`.
- If CI fails, fix the code. Never skip, disable or weaken a test to get a green check.

## Secrets — hard rules

- Never write a password, token, API key or session secret into any file, commit, pull request, issue, log or chat message.
- Secrets exist only as Cloudflare Worker secrets that Bob sets in the dashboard: `PLAYER_PASSWORD`, `ADMIN_PASSWORD`, `SESSION_SECRET`. Code reads them from `env` only.
- Never ask Bob to paste a secret into the session. If something needs a secret, tell him which dashboard setting to change.
- Local values go in `.dev.vars`, which is gitignored from the first commit. Commit `.dev.vars.example` with variable names and empty values only.
- Tests use obviously fake values defined in the test config.
- Before every commit, scan the diff for anything that looks like a credential. If you find one, stop and tell Bob.
- You have no Cloudflare credentials. Never run wrangler commands that touch remote resources (`deploy`, `secret`, or anything with `--remote`).
- This repo is public. Do not put real friends' names, personal email addresses or private details in code, the catalog, tests or docs.

## Database and catalog

- A schema change means a new migration file. Migrations must be additive and backward-compatible, because they run before the new code goes live. Never edit a migration that has already been applied.
- A catalog change means editing `catalog/catalog.json` only. IDs are stable kebab-case. Never reuse or rename an ID. To retire a task, remove it or set `"active": false`.
- Never import catalog or game data into the client bundle. The client gets data from the API only.

## Code rules

- The server is authoritative. State changes, the timer, the puzzle lock and the winner are all enforced in the Worker, never only in the client.
- Game rules (roll, complete/undo, puzzle lock, finalize) live in pure functions with unit tests.
- Every API endpoint gets an integration test against D1.
- Use parameterized queries only.
- Store all times as UTC epoch milliseconds.

## Design

- Clean, mobile-first scoreboard with touch targets of at least 48px.
- Colors: orange #FA4616, blue #0021A5, navy #002657, white. Use orange only for accents and large text, because it has low contrast on white.
- Fonts from Google Fonts: IBM Plex Sans for body text; Anybody for headings, the timer and scores.
- No university logos, mascots or wordmarks, and no "Gators" anywhere in the UI.

## Definition of done

- `check`, `test` and `build` pass, and CI is green.
- The pull request description says what changed, how it was tested, and any dashboard step Bob needs to take.
