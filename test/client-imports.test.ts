/// <reference types="vite/client" />
// CLAUDE.md: "Never import catalog or game data into the client bundle. The client gets
// data from the API only." Bob also decided the Worker reads the catalog from D1 only,
// so neither src/client nor src/worker may import catalog/catalog.json or scripts/.
import { describe, expect, it } from "vitest";

const clientSources = import.meta.glob<string>("../src/client/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

const workerSources = import.meta.glob<string>("../src/worker/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Every module specifier in static imports, re-exports, side-effect imports, dynamic imports and require(). */
function moduleSpecifiers(source: string): string[] {
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  ];
  const out: string[] = [];
  for (const re of patterns) for (const m of source.matchAll(re)) if (m[1]) out.push(m[1]);
  return out;
}

/**
 * A forbidden specifier points at catalog.json, the catalog script module, or scripts/.
 * Local modules such as "./pages/Catalog" or "./catalog" (which would fetch from the
 * API or read D1) are allowed.
 */
function isForbiddenSpecifier(spec: string): boolean {
  return /catalog\.json(\?.*)?$/.test(spec) || /(^|\/)scripts\//.test(spec) || /catalog\.mjs(\?.*)?$/.test(spec);
}

function offenders(sources: Record<string, string>): string[] {
  const bad: string[] = [];
  for (const [file, src] of Object.entries(sources)) {
    for (const spec of moduleSpecifiers(src)) if (isForbiddenSpecifier(spec)) bad.push(`${file} imports ${spec}`);
  }
  return bad;
}

describe("CLAUDE.md: no catalog in the client — the import detector", () => {
  it.each([
    'import catalog from "../../catalog/catalog.json";',
    "import catalog from '../../catalog/catalog.json?raw';",
    'import { parseCatalog } from "../../scripts/lib/catalog.mjs";',
    'export { validateCatalog } from "../../scripts/lib/catalog.mjs";',
    'import "../../catalog/catalog.json";',
    'const c = await import("../../catalog/catalog.json");',
    "const c = await import(`../../scripts/lib/catalog.mjs`);",
    'import type { Catalog } from "../../scripts/lib/catalog.mjs";',
    'const c = require("../../catalog/catalog.json");',
  ])("flags %s", (line) => {
    expect(offenders({ "x.ts": line })).toHaveLength(1);
  });

  it.each([
    'import { CatalogView } from "./pages/Catalog";',
    'import { getCatalog } from "./catalog";',
    'import { readCatalog } from "../db/catalog";',
    'import { readCatalog } from "./catalog/read";',
    'import { h } from "preact";',
    'const label = "catalog";',
  ])("allows %s", (line) => {
    expect(offenders({ "x.ts": line })).toEqual([]);
  });
});

describe("CLAUDE.md: no catalog in the client", () => {
  it("finds the client source files", () => {
    expect(Object.keys(clientSources).length).toBeGreaterThan(0);
    for (const src of Object.values(clientSources)) expect(typeof src).toBe("string");
  });

  it("no client file imports catalog/catalog.json or scripts/", () => {
    expect(offenders(clientSources)).toEqual([]);
  });
});

describe("CLAUDE.md: the Worker reads the catalog from D1 only", () => {
  it("finds the worker source files", () => {
    expect(Object.keys(workerSources).length).toBeGreaterThan(0);
    for (const src of Object.values(workerSources)) expect(typeof src).toBe("string");
  });

  it("no worker file imports catalog/catalog.json or scripts/", () => {
    expect(offenders(workerSources)).toEqual([]);
  });
});
