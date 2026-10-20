import { describe, expect, it } from "vitest";
import { base64urlEncode, hmacSign } from "../src/worker/auth/crypto";
import { PUBLIC_ROUTES } from "../src/worker/auth/middleware";
import { signSession } from "../src/worker/auth/session";
import { NOW, SESSION_SECRET, cookieFor, expectError, makeDeps, testApp, withCookie } from "./helpers/auth";

const ROTATED_AWAY_SECRET = "fake-old-session-secret-rotated-away";

async function anon(method: string, path: string) {
  return testApp().request(path, { method });
}

describe("§3 §10 public routes", () => {
  it("are exactly login, logout, admin login and health", () => {
    expect([...PUBLIC_ROUTES]).toEqual(["POST /api/login", "POST /api/logout", "POST /api/admin/login", "GET /api/health"]);
  });

  it("GET /api/health needs no session", async () => {
    const res = await anon("GET", "/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, env: "local" });
  });
});

describe("§3 §10 anonymous requests to protected routes get 401", () => {
  const routes: Array<[string, string]> = [
    ["GET", "/api/session"],
    ["GET", "/api/games/ABCDE"],
    ["POST", "/api/games"],
    ["GET", "/api/history"],
    ["GET", "/api/admin/games"],
    ["GET", "/api/admin"],
    // Auth runs before routing: unknown paths are not revealed as 404.
    ["GET", "/api/nope"],
    ["GET", "/api"],
    // The public-route check is exact on method and path.
    ["GET", "/api/login"],
    ["POST", "/api/login/"],
    ["GET", "/api/logout"],
    ["GET", "/api/admin/login"],
    ["POST", "/api/admin/login/"],
    ["POST", "/api/health"],
    ["GET", "/api/health/"],
  ];

  it.each(routes)("%s %s", async (method, path) => {
    await expectError(await anon(method, path), 401, "unauthorized", "Log in to continue");
  });
});

describe("§3 invalid session cookies get 401", () => {
  const cases: Array<[string, () => Promise<string>]> = [
    ["an empty session cookie", async () => "session="],
    ["a garbage value", async () => "session=garbage"],
    ["a malformed token", async () => "session=a.b.c"],
    ["an expired cookie (exp < now)", () => cookieFor("player", { exp: NOW - 1 })],
    ["a cookie expiring exactly now", () => cookieFor("admin", { exp: NOW })],
    [
      "a payload re-encoded as admin with the player signature",
      async () => {
        const token = (await cookieFor("player")).slice("session=".length);
        const sig = token.split(".")[1];
        const payload = base64urlEncode(new TextEncoder().encode(JSON.stringify({ role: "admin", exp: NOW + 1000 })));
        return `session=${payload}.${sig}`;
      },
    ],
    [
      "a correctly signed unknown role",
      async () => {
        const payload = base64urlEncode(new TextEncoder().encode(JSON.stringify({ role: "superuser", exp: NOW + 1000 })));
        return `session=${payload}.${await hmacSign(SESSION_SECRET, payload)}`;
      },
    ],
    ["a valid token under a different cookie name", async () => `sess=${(await cookieFor("player")).slice("session=".length)}`],
  ];

  it.each(cases)("%s", async (_name, make) => {
    const res = await testApp().request("/api/session", withCookie(await make()));
    await expectError(res, 401, "unauthorized", "Log in to continue");
  });
});

describe("§3 changing SESSION_SECRET logs everyone out", () => {
  it.each(["player", "admin"] as const)("a %s cookie signed with an old secret gets 401", async (role) => {
    const cookie = `session=${await signSession({ role, exp: NOW + 60_000 }, ROTATED_AWAY_SECRET)}`;
    const res = await testApp().request("/api/session", withCookie(cookie));
    await expectError(res, 401, "unauthorized", "Log in to continue");
  });
});

describe("§3 session expiry uses the injected clock", () => {
  it("accepts a cookie at exp - 1 and rejects it at exp", async () => {
    const exp = NOW + 1000;
    const cookie = await cookieFor("player", { exp });
    const before = await testApp(makeDeps({ now: exp - 1 }).deps).request("/api/session", withCookie(cookie));
    expect(before.status).toBe(200);
    const at = await testApp(makeDeps({ now: exp }).deps).request("/api/session", withCookie(cookie));
    await expectError(at, 401, "unauthorized", "Log in to continue");
  });
});

describe("§3 valid sessions", () => {
  it("finds the session cookie among other cookies", async () => {
    const cookie = `other=1; ${await cookieFor("player")}; theme=dark`;
    const res = await testApp().request("/api/session", withCookie(cookie));
    expect(res.status).toBe(200);
  });

  it("does not re-issue the cookie on authenticated requests", async () => {
    for (const role of ["player", "admin"] as const) {
      const res = await testApp().request("/api/session", withCookie(await cookieFor(role)));
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  });

  it("a player on an unknown path gets the JSON 404", async () => {
    const res = await testApp().request("/api/nope", withCookie(await cookieFor("player")));
    await expectError(res, 404, "not_found", "Not found");
  });
});

describe("§3 §10 role checks (403)", () => {
  const adminPaths: Array<[string, string]> = [
    ["GET", "/api/admin"],
    ["GET", "/api/admin/"],
    ["GET", "/api/admin/games"],
    ["PATCH", "/api/admin/games/ABCDE"],
    ["DELETE", "/api/admin/games/ABCDE"],
    ["GET", "/api/admin/catalog"],
    ["GET", "/api/admin/login"],
  ];

  it.each(adminPaths)("a player gets 403 on %s %s", async (method, path) => {
    const res = await testApp().request(path, withCookie(await cookieFor("player"), { method }));
    await expectError(res, 403, "forbidden", "Admin access required");
  });

  it("a player on a path that only starts with 'admin' is not treated as admin (404)", async () => {
    const res = await testApp().request("/api/administrator", withCookie(await cookieFor("player")));
    await expectError(res, 404, "not_found", "Not found");
  });

  it.each(adminPaths)("an admin passes auth on %s %s (404: no admin routes yet)", async (method, path) => {
    const res = await testApp().request(path, withCookie(await cookieFor("admin"), { method }));
    await expectError(res, 404, "not_found", "Not found");
  });

  it("an admin also has player access", async () => {
    const res = await testApp().request("/api/nope", withCookie(await cookieFor("admin")));
    await expectError(res, 404, "not_found", "Not found");
  });
});
