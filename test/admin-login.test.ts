import { describe, expect, it } from "vitest";
import { ADMIN_TTL_MS, verifySession } from "../src/worker/auth/session";
import {
  ADMIN_PASSWORD,
  NOW,
  PLAYER_PASSWORD,
  SESSION_SECRET,
  cookieFor,
  jsonInit,
  parseSetCookie,
  testApp,
  withCookie,
} from "./helpers/auth";
import { loginSuite } from "./helpers/login-suite";

loginSuite({
  label: "§3 §9 §10 admin login (POST /api/admin/login)",
  path: "/api/admin/login",
  role: "admin",
  correctPassword: () => ADMIN_PASSWORD,
  otherPassword: () => PLAYER_PASSWORD,
  ttlMs: ADMIN_TTL_MS,
  maxAge: "43200",
});

describe("§3 admin login (POST /api/admin/login): existing sessions", () => {
  it("replaces an existing player cookie with an admin session", async () => {
    const { request } = testApp();
    const res = await request(
      "/api/admin/login",
      withCookie(await cookieFor("player"), jsonInit({ password: ADMIN_PASSWORD })),
    );
    expect(res.status).toBe(200);
    const cookies = parseSetCookie(res);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]?.name).toBe("session");
    const token = cookies[0]?.value ?? "";
    expect(await verifySession(token, SESSION_SECRET, NOW)).toEqual({ role: "admin", exp: NOW + ADMIN_TTL_MS });

    // The new cookie grants admin access: the admin list answers 200, not 403.
    const admin = await request("/api/admin/games", { headers: { cookie: `session=${token}` } });
    expect(admin.status).toBe(200);
  });

  it("is reachable by a logged-in player (public route, not 403)", async () => {
    const res = await testApp().request(
      "/api/admin/login",
      withCookie(await cookieFor("player"), jsonInit({ password: "fake-wrong-password" })),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", message: "Wrong password" });
  });
});
