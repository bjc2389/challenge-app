# Challenge App

A two-team party race game. See [SPEC.md](SPEC.md) for what it does and [CLAUDE.md](CLAUDE.md) for how the repo is run.

## Local development

```sh
npm ci
cp .dev.vars.example .dev.vars   # fill in local-only values
npm run db:local                 # create or update the local database (safe to repeat)
npm run dev                      # builds the client, then serves everything on http://localhost:8787
```

`.dev.vars` needs all three values: `PLAYER_PASSWORD`, `ADMIN_PASSWORD`, and a `SESSION_SECRET` of at least 32 characters. Without them, login returns a 500.

The session cookie is always `Secure`. Chrome and Firefox accept that on `http://localhost`; Safari may not, so use Chrome or Firefox for local testing.

`npm run check`, `npm test`, `npm run build`, `npm run verify:deploy` and `npm run db:local` are what CI runs.

## Deploying

Cloudflare Workers Builds deploys each environment from its branch. Nobody deploys by hand.

| | Staging | Production |
|---|---|---|
| Worker | `challenge-app-staging` | `challenge-app-production` |
| Branch | `staging` | `main` |
| D1 database | `challenge-app-staging-db` | `challenge-app-production-db` |
| Deploy command | `npm run deploy:staging` | `npm run deploy:production` |

Build settings for each Worker (Settings → Build):

- Build command: `npm ci && npm run check && npm test && npm run build`
- Deploy command: from the table. It validates the catalog, applies D1 migrations, syncs the catalog, then deploys.
- Non-production branch builds: off.
- The build's API token needs **Account → D1 → Edit**.

Runtime secrets, per Worker, under Settings → Variables and Secrets, type **Secret** (not build variables):

- `PLAYER_PASSWORD` and `ADMIN_PASSWORD`, different from each other.
- `SESSION_SECRET`: at least 32 characters, for example from `openssl rand -base64 48` run on your own machine.
- Use different values in staging and production. Changing `SESSION_SECRET` logs everyone out.

`APP_ENV` comes from `wrangler.jsonc`; don't set it in the dashboard. To check a deploy, open `/api/health`: it returns `{"ok":true,"env":"<environment>"}`. Rollback is Workers → Deployments → an earlier version (code only; migrations are additive).
