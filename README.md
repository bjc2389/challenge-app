# Challenge App

A two-team party race game. See [SPEC.md](SPEC.md) for what it does and [CLAUDE.md](CLAUDE.md) for how the repo is run.

## Local development

```sh
npm ci
cp .dev.vars.example .dev.vars   # fill in local-only values
npm run dev                      # builds the client, then serves everything on http://localhost:8787
```

`npm run check`, `npm test` and `npm run build` are what CI runs.
