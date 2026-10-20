import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
