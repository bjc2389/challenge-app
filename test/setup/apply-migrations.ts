import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Idempotent: applied migrations are recorded in d1_migrations.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
