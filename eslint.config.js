import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", ".wrangler/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs", ".claude/hooks/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  {
    // The catalog reaches the app only through D1 and the API (CLAUDE.md).
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/catalog/**", "**/catalog.json", "**/scripts/**"],
              message: "The app reads catalog data from D1 (Worker) or the API (client), never the file.",
            },
          ],
        },
      ],
    },
  },
  {
    // Ambient type augmentation needs an empty interface and a namespace.
    files: ["**/*.d.ts"],
    rules: {
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-namespace": "off",
    },
  },
);
