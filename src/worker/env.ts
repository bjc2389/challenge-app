export interface Env {
  APP_ENV: string;
  ASSETS: Fetcher;
  DB: D1Database;
  // Worker secrets, set in the Cloudflare dashboard. Typed as optional so every
  // use has to handle a missing value.
  PLAYER_PASSWORD: string | undefined;
  ADMIN_PASSWORD: string | undefined;
  SESSION_SECRET: string | undefined;
}
