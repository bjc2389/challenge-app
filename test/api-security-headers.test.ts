// M7: every /api response carries the API security headers (SPEC.md §3, §10), on
// success and on every error path (401, 403, 404, 422, 500).
// The /api/health and unknown-route cases go through the real Worker entry
// (exports.default.fetch), as test/health.test.ts does; the rest use testApp.
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAYER_TTL_MS } from "../src/worker/auth/session";
import { API_SECURITY_HEADERS, securityHeaders } from "../src/worker/headers";
import {
  PLAYER_PASSWORD,
  cookieFor,
  expectError,
  expectValidationError,
  jsonInit,
  makeDeps,
  testApp,
  withCookie,
} from "./helpers/auth";
import { resetDb } from "./helpers/db";
import { createGame, gameUrl, player, readView } from "./helpers/game";
import { EXPECTED_API_SECURITY_HEADERS, expectApiSecurityHeaders } from "./helpers/security-headers";

describe("§3 §10 API_SECURITY_HEADERS constant", () => {
  it("exports the middleware", () => {
    expect(typeof securityHeaders).toBe("function");
  });

  it("holds exactly the approved values", () => {
    // Header names are case-insensitive; compare them lowercased.
    const lower = (r: Record<string, string>) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v]));
    expect(lower(API_SECURITY_HEADERS)).toEqual(lower(EXPECTED_API_SECURITY_HEADERS));
  });
});

describe("§3 §10 security headers through the real Worker entry", () => {
  it("GET /api/health → 200 with the headers", async () => {
    const res = await exports.default.fetch("http://example.com/api/health");
    expect(res.status).toBe(200);
    expectApiSecurityHeaders(res);
    expect(await res.json()).toEqual({ ok: true, env: "local" });
  });

  it("unknown /api/nope with a player cookie → 404 with the headers", async () => {
    // The real entry uses the real clock, so the cookie must expire in the future.
    const cookie = await cookieFor("player", { exp: Date.now() + PLAYER_TTL_MS });
    const res = await exports.default.fetch("http://example.com/api/nope", { headers: { cookie } });
    expectApiSecurityHeaders(res);
    await expectError(res, 404, "not_found", "Not found");
  });
});

describe("§3 §10 security headers on auth responses", () => {
  it("GET /api/games with no session → 401 with the headers", async () => {
    const res = await testApp().request("/api/games");
    expectApiSecurityHeaders(res);
    await expectError(res, 401, "unauthorized", "Log in to continue");
  });

  it("a successful POST /api/login → headers present and Set-Cookie still set", async () => {
    const res = await testApp().request("/api/login", jsonInit({ password: PLAYER_PASSWORD }));
    expect(res.status).toBe(200);
    expectApiSecurityHeaders(res);
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^session=/);
  });

  it("a wrong password → 401 with the headers", async () => {
    const { deps } = makeDeps();
    const res = await testApp(deps).request("/api/login", jsonInit({ password: "fake-wrong-password" }));
    expectApiSecurityHeaders(res);
    await expectError(res, 401, "unauthorized", "Wrong password");
  });

  it("a body that isn't JSON → 422 with the headers", async () => {
    const res = await testApp().request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json{",
    });
    expectApiSecurityHeaders(res);
    await expectValidationError(res);
  });

  it("a cross-origin POST → 403 with the headers", async () => {
    const res = await testApp().request("http://localhost/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ password: "fake-wrong-password" }),
    });
    expectApiSecurityHeaders(res);
    await expectError(res, 403, "forbidden", "Cross-origin request blocked");
  });

  it("a player cookie on /api/admin/games → 403 with the headers", async () => {
    const res = await testApp().request("/api/admin/games", withCookie(await cookieFor("player")));
    expectApiSecurityHeaders(res);
    await expectError(res, 403, "forbidden", "Admin access required");
  });
});

describe("§3 §10 security headers on a 500 (SESSION_SECRET missing)", () => {
  beforeEach(() => {
    // The missing secret's name is logged; keep test output quiet.
    for (const m of ["error", "warn", "log", "info", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation(() => {});
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it("a protected route → 500 {error: internal} with the headers", async () => {
    const res = await testApp().request("/api/session", {}, { SESSION_SECRET: undefined });
    expectApiSecurityHeaders(res);
    await expectError(res, 500, "internal", "Something went wrong");
  });
});

describe("§10 security headers on a game response", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("GET /api/games/:code for a created game → 200 with the headers", async () => {
    const api = await player(makeDeps().deps);
    const { game } = await createGame(api);
    const res = await api.get(gameUrl(game.code));
    expectApiSecurityHeaders(res);
    const view = await readView(res);
    expect(view.game.code).toBe(game.code);
  });
});
