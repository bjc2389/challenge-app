import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // Read on the Node side; test/setup/apply-migrations.ts applies them in workerd.
  const migrations = await readD1Migrations("./migrations");

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // Obviously fake values. These override anything in a local .dev.vars,
        // so tests behave the same on every machine and in CI.
        miniflare: {
          bindings: {
            PLAYER_PASSWORD: "fake-player-password-for-tests",
            ADMIN_PASSWORD: "fake-admin-password-for-tests",
            SESSION_SECRET: "fake-session-secret-for-tests-only-not-real",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup/apply-migrations.ts"],
      // Vitest stubs .css imports to "" by default; the static-assets test reads the
      // real stylesheet to check the reduced-motion rules.
      css: { include: [/src\/client\/styles\.css/] },
    },
  };
});
