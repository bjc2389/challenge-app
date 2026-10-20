import { describe, expect, it } from "vitest";
import { ADMIN_TTL_MS, PLAYER_TTL_MS } from "../src/worker/auth/session";
import { NOW, cookieFor, expectError, testApp, withCookie } from "./helpers/auth";

describe("§3 GET /api/session", () => {
  it("returns {role, exp} for a player", async () => {
    const res = await testApp().request("/api/session", withCookie(await cookieFor("player")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "player", exp: NOW + PLAYER_TTL_MS });
  });

  it("returns {role, exp} for an admin", async () => {
    const res = await testApp().request("/api/session", withCookie(await cookieFor("admin")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "admin", exp: NOW + ADMIN_TTL_MS });
  });

  it("does not re-issue or extend the cookie (expiry is fixed)", async () => {
    const res = await testApp().request("/api/session", withCookie(await cookieFor("player", { exp: NOW + 5 })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "player", exp: NOW + 5 });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("returns 401 with no cookie", async () => {
    await expectError(await testApp().request("/api/session"), 401, "unauthorized", "Log in to continue");
  });

  it("returns 401 with an expired cookie", async () => {
    const res = await testApp().request("/api/session", withCookie(await cookieFor("player", { exp: NOW })));
    await expectError(res, 401, "unauthorized", "Log in to continue");
  });
});
