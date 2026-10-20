# Challenge App

A two-team party race game. See [SPEC.md](SPEC.md) for what it does and [CLAUDE.md](CLAUDE.md) for how the repo is run.

## Local development

```sh
npm ci
cp .dev.vars.example .dev.vars   # fill in local-only values
npm run dev                      # builds the client, then serves everything on http://localhost:8787
```

`.dev.vars` needs all three values: `PLAYER_PASSWORD`, `ADMIN_PASSWORD`, and a `SESSION_SECRET` of at least 32 characters. Without them, login returns a 500.

The session cookie is always `Secure`. Chrome and Firefox accept that on `http://localhost`; Safari may not, so use Chrome or Firefox for local testing.

`npm run check`, `npm test`, `npm run build` and `npm run verify:deploy` are what CI runs.
