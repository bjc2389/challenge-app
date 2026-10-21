// Shared cases for POST /api/login and POST /api/admin/login (SPEC.md §3, §10).
import { describe, expect, it, vi } from "vitest";
import { LOGIN_FAILURE_DELAY_MS } from "../../src/worker/app";
import { verifySession, type Role } from "../../src/worker/auth/session";
import {
  NOW,
  SESSION_SECRET,
  expectError,
  expectValidationError,
  jsonInit,
  makeDeps,
  parseSetCookie,
  testApp,
} from "./auth";

export type LoginSuiteConfig = {
  label: string; // e.g. "§3 player login (POST /api/login)"
  path: string;
  role: Role;
  correctPassword: () => string;
  /** The other role's password, which must not work here. */
  otherPassword: () => string;
  ttlMs: number;
  maxAge: string;
};

export function loginSuite(cfg: LoginSuiteConfig) {
  describe(`${cfg.label}: success`, () => {
    it(`returns 200 {ok: true, role: "${cfg.role}"} without delay`, async () => {
      const { deps, delays } = makeDeps();
      const res = await testApp(deps).request(cfg.path, jsonInit({ password: cfg.correctPassword() }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, role: cfg.role });
      expect(delays).toEqual([]);
    });

    it("sets exactly one session cookie: HttpOnly, Secure, SameSite=Lax, Path=/, correct Max-Age, no Domain", async () => {
      const res = await testApp().request(cfg.path, jsonInit({ password: cfg.correctPassword() }));
      const cookies = parseSetCookie(res);
      expect(cookies).toHaveLength(1);
      const [cookie] = cookies;
      expect(cookie?.name).toBe("session");
      expect(cookie?.value).not.toBe("");
      expect(cookie?.attrs.httponly).toBe(true);
      expect(cookie?.attrs.secure).toBe(true);
      expect(String(cookie?.attrs.samesite).toLowerCase()).toBe("lax");
      expect(cookie?.attrs.path).toBe("/");
      expect(cookie?.attrs["max-age"]).toBe(cfg.maxAge);
      expect(cookie?.attrs).not.toHaveProperty("domain");
    });

    it(`signs {role: "${cfg.role}", exp: now + TTL} with SESSION_SECRET, using the injected clock`, async () => {
      const now = NOW + 12_345;
      const { deps } = makeDeps({ now });
      const res = await testApp(deps).request(cfg.path, jsonInit({ password: cfg.correctPassword() }));
      const token = parseSetCookie(res)[0]?.value ?? "";
      expect(await verifySession(token, SESSION_SECRET, now)).toEqual({ role: cfg.role, exp: now + cfg.ttlMs });
    });

    it("issues a cookie that the API then accepts on GET /api/session", async () => {
      const { request } = testApp();
      const login = await request(cfg.path, jsonInit({ password: cfg.correctPassword() }));
      const token = parseSetCookie(login)[0]?.value ?? "";
      const res = await request("/api/session", { headers: { cookie: `session=${token}` } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ role: cfg.role, exp: NOW + cfg.ttlMs });
    });
  });

  describe(`${cfg.label}: wrong password (401 after ~1 s)`, () => {
    it("the failure delay constant is 1000 ms", () => {
      expect(LOGIN_FAILURE_DELAY_MS).toBe(1000);
    });

    it("stays pending until the injected delay resolves, then returns 401 with no cookie", async () => {
      const { deps, delays, releaseDelays } = makeDeps({ manualDelay: true });
      let settled = false;
      const pending = testApp(deps)
        .request(cfg.path, jsonInit({ password: "fake-wrong-password" }))
        .then((r) => {
          settled = true;
          return r;
        });

      await vi.waitFor(() => expect(delays).toEqual([1000]));
      // Let any queued work run; the response must still be waiting on the delay.
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
      expect(settled).toBe(false);

      releaseDelays();
      const res = await pending;
      await expectError(res, 401, "unauthorized", "Wrong password");
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(delays).toEqual([1000]);
    });

    const wrong: Array<[string, () => string]> = [
      ["an empty password", () => ""],
      ["the other role's password", cfg.otherPassword],
      ["a prefix of the correct password", () => cfg.correctPassword().slice(0, -1)],
      ["the correct password plus a trailing space", () => `${cfg.correctPassword()} `],
      ["the correct password in upper case", () => cfg.correctPassword().toUpperCase()],
    ];

    it.each(wrong)("rejects %s with 401 after one 1000 ms delay", async (_name, pw) => {
      const { deps, delays } = makeDeps();
      const res = await testApp(deps).request(cfg.path, jsonInit({ password: pw() }));
      await expectError(res, 401, "unauthorized", "Wrong password");
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(delays).toEqual([1000]);
    });
  });

  describe(`${cfg.label}: validation (422)`, () => {
    const bad: Array<[string, RequestInit]> = [
      ["a body that is not JSON", { method: "POST", headers: { "content-type": "application/json" }, body: "not json{" }],
      ["an empty body", { method: "POST", headers: { "content-type": "application/json" }, body: "" }],
      ["an empty object", jsonInit({})],
      ["password: null", jsonInit({ password: null })],
      ["password as a number", jsonInit({ password: 12345678 })],
      ["password as an array", jsonInit({ password: ["x"] })],
      ["password as an object", jsonInit({ password: { value: "x" } })],
      ["a JSON null body", jsonInit(null)],
      ["a JSON array body", jsonInit([])],
      ["a JSON string body", jsonInit("just-a-string")],
    ];

    it.each(bad)("returns 422 for %s, with no delay and no cookie", async (_name, init) => {
      const { deps, delays } = makeDeps();
      const res = await testApp(deps).request(cfg.path, init);
      await expectValidationError(res);
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(delays).toEqual([]);
    });
  });
}
