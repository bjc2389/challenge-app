import { describe, expect, it } from "vitest";
import { PLAYER_TTL_MS } from "../src/worker/auth/session";
import { ADMIN_PASSWORD, PLAYER_PASSWORD, cookieFor, jsonInit, makeDeps, testApp, withCookie } from "./helpers/auth";
import { loginSuite } from "./helpers/login-suite";

loginSuite({
  label: "§3 §10 player login (POST /api/login)",
  path: "/api/login",
  role: "player",
  correctPassword: () => PLAYER_PASSWORD,
  otherPassword: () => ADMIN_PASSWORD,
  ttlMs: PLAYER_TTL_MS,
  maxAge: "2592000",
});

describe("§3 §10 player login (POST /api/login): public route", () => {
  it("works with no cookie and with an expired or invalid cookie", async () => {
    const expired = await cookieFor("player", { exp: 1 });
    for (const cookie of [expired, "session=garbage"]) {
      const { deps, delays } = makeDeps();
      const res = await testApp(deps).request("/api/login", withCookie(cookie, jsonInit({ password: PLAYER_PASSWORD })));
      expect(res.status).toBe(200);
      expect(delays).toEqual([]);
    }
  });
});
