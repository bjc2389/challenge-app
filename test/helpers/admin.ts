// Shared helpers for the M6 admin tests (SPEC.md §3 admin auth, §7 catalog read-only,
// §8 delete order, §9 /admin, §10 admin endpoints).
// The admin cookie is signed at runtime with the fake test secret (cookieFor("admin")).
// Every statement that carries a value is prepared and bound; nothing is interpolated.
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { cookieFor, testApp, type Deps } from "./auth";

// ---------------------------------------------------------------------------
// Response shapes (test-side copies of the approved M6 plan; the client types are
// checked against the Worker in client-admin-contract.test.ts)
// ---------------------------------------------------------------------------

export type AdminTeamBody = { id: number; slot: 1 | 2; name: string; score: number };

export type AdminGameBody = {
  code: string;
  status: "setup" | "rolled" | "active" | "finished" | "abandoned";
  isTest: boolean;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  endReason: "completed" | "timeout" | null;
  winnerTeamId: number | null;
  elapsedMs: number | null;
  teams: AdminTeamBody[];
};

export type AdminGameListBody = { items: AdminGameBody[] };

export type AdminTaskBody = { id: string; text: string; active: boolean };

export type AdminCategoryBody = {
  id: string;
  name: string;
  order: number;
  countPerGame: number;
  final: boolean;
  active: boolean;
  tasks: AdminTaskBody[];
};

export type AdminCatalogBody = { categories: AdminCategoryBody[] };

export const ADMIN_GAME_KEYS = [
  "code",
  "createdAt",
  "elapsedMs",
  "endReason",
  "endedAt",
  "isTest",
  "startedAt",
  "status",
  "teams",
  "winnerTeamId",
];
export const ADMIN_TEAM_KEYS = ["id", "name", "score", "slot"];
export const ADMIN_CATEGORY_KEYS = ["active", "countPerGame", "final", "id", "name", "order", "tasks"];
export const ADMIN_TASK_KEYS = ["active", "id", "text"];

export const sortedKeys = (o: object) => Object.keys(o).sort();

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const ADMIN_GAMES_URL = "/api/admin/games";
export const ADMIN_CATALOG_URL = "/api/admin/catalog";
export const adminGameUrl = (code: string) => `/api/admin/games/${code}`;

export type AdminApi = {
  deps: Deps;
  cookie: string;
  /** JSON request with the admin cookie. `body` undefined sends no body. */
  request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  /** Request with a raw (possibly invalid) body. `body` undefined sends none. */
  raw(
    method: string,
    path: string,
    body: string | undefined,
    contentType?: string,
    headers?: Record<string, string>,
  ): Promise<Response>;
  get(path: string): Promise<Response>;
  patch(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  delete(path: string, headers?: Record<string, string>): Promise<Response>;
};

/**
 * A request helper carrying an admin cookie signed at runtime with the fake secret.
 * `opts.exp` overrides the cookie's expiry (default: NOW + 12 hours).
 */
export async function admin(deps: Deps, opts: { exp?: number } = {}): Promise<AdminApi> {
  const cookie = await cookieFor("admin", opts.exp === undefined ? {} : { exp: opts.exp });
  const app = testApp(deps);
  const raw: AdminApi["raw"] = (method, path, body, contentType = "application/json", headers = {}) =>
    app.request(path, {
      method,
      headers: body === undefined ? { cookie, ...headers } : { cookie, "content-type": contentType, ...headers },
      body,
    });
  const request: AdminApi["request"] = (method, path, body, headers) =>
    raw(method, path, body === undefined ? undefined : JSON.stringify(body), "application/json", headers);
  return {
    deps,
    cookie,
    request,
    raw,
    get: (path) => request("GET", path),
    patch: (path, body, headers) => request("PATCH", path, body, headers),
    delete: (path, headers) => request("DELETE", path, undefined, headers),
  };
}

async function readJson<T>(res: Response, status: number): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

/** GET /api/admin/games, asserting 200. */
export async function listAdminGames(adm: AdminApi): Promise<AdminGameListBody> {
  return readJson<AdminGameListBody>(await adm.get(ADMIN_GAMES_URL), 200);
}

/** The list item for `code`, or a failure if it isn't listed. */
export async function adminItem(adm: AdminApi, code: string): Promise<AdminGameBody> {
  const item = (await listAdminGames(adm)).items.find((g) => g.code === code);
  if (!item) throw new Error(`adminItem: ${code} is not in the admin list`);
  return item;
}

/** PATCH /api/admin/games/:code with `{isTest}`, asserting 200. */
export async function setTest(adm: AdminApi, code: string, isTest: boolean): Promise<AdminGameBody> {
  return readJson<AdminGameBody>(await adm.patch(adminGameUrl(code), { isTest }), 200);
}

/** GET /api/admin/catalog, asserting 200. */
export async function getAdminCatalog(adm: AdminApi): Promise<AdminCatalogBody> {
  return readJson<AdminCatalogBody>(await adm.get(ADMIN_CATALOG_URL), 200);
}

export { readJson as readAdminJson };

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

export async function isTestFlag(code: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT is_test FROM games WHERE code = ?").bind(code).first<{ is_test: number }>();
  return row ? row.is_test : null;
}

/** Every game row, for "nothing changed" assertions across the whole table. */
export async function allGameRows(): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM games ORDER BY id").all<Record<string, unknown>>();
  return results;
}

/** Row counts across every game table, for "nothing else was deleted" assertions. */
export async function tableCounts(): Promise<Record<string, number>> {
  const tables = ["games", "teams", "game_tasks", "team_tasks", "task_events", "categories", "catalog_tasks"] as const;
  const out: Record<string, number> = {};
  for (const t of tables) {
    // Table names come from the fixed list above, never from input.
    out[t] = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())?.n ?? -1;
  }
  return out;
}
