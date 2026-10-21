import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { signSession } from "../src/worker/auth/session";
import {
  ADMIN_PASSWORD,
  NOW,
  PLAYER_PASSWORD,
  SESSION_SECRET,
  cookieFor,
  jsonInit,
  makeDeps,
  testApp,
  withCookie,
  type EnvOverride,
} from "./helpers/auth";

// 31 and 32 characters: just under and exactly at MIN_SESSION_SECRET_LENGTH.
const SHORT_SECRET = "fake-session-secret-".padEnd(31, "x");
const MIN_LENGTH_SECRET = "fake-session-secret-".padEnd(32, "x");
const NAMES = ["PLAYER_PASSWORD", "ADMIN_PASSWORD", "SESSION_SECRET"];
const VALUES = [PLAYER_PASSWORD, ADMIN_PASSWORD, SESSION_SECRET, SHORT_SECRET];

let logSpies: MockInstance[] = [];

beforeEach(() => {
  // Misconfiguration may be logged; keep output quiet and inspect what was logged.
  logSpies = (["error", "warn", "log", "info", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
});

afterEach(() => vi.restoreAllMocks());

async function expectInternal(res: Response) {
  expect(res.status).toBe(500);
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ error: "internal", message: "Something went wrong" });
  for (const s of [...NAMES, ...VALUES]) expect(text).not.toContain(s);
  expect(res.headers.getSetCookie()).toEqual([]);
}

function expectNoSecretsLogged() {
  const logged = logSpies.flatMap((s) => s.mock.calls).map((args) => args.map((a) => String(a)).join(" "));
  for (const line of logged) for (const v of VALUES) expect(line).not.toContain(v);
}

const missing: Array<[string, unknown]> = [
  ["undefined", undefined],
  ["empty", ""],
];

describe("§3 missing PLAYER_PASSWORD", () => {
  it.each(missing)("player login returns 500 with no cookie and no delay when %s", async (_n, value) => {
    const { deps, delays } = makeDeps();
    const res = await testApp(deps).request("/api/login", jsonInit({ password: "fake-any-password" }), {
      PLAYER_PASSWORD: value,
    });
    await expectInternal(res);
    expect(delays).toEqual([]);
    expectNoSecretsLogged();
  });

  it("submitting an empty password against an empty PLAYER_PASSWORD returns 500, never 200", async () => {
    const { deps, delays } = makeDeps();
    const res = await testApp(deps).request("/api/login", jsonInit({ password: "" }), { PLAYER_PASSWORD: "" });
    await expectInternal(res);
    expect(delays).toEqual([]);
  });

  it("admin login still works", async () => {
    const res = await testApp().request("/api/admin/login", jsonInit({ password: ADMIN_PASSWORD }), {
      PLAYER_PASSWORD: undefined,
    });
    expect(res.status).toBe(200);
  });
});

describe("§3 missing ADMIN_PASSWORD", () => {
  it.each(missing)("admin login returns 500 with no cookie and no delay when %s", async (_n, value) => {
    const { deps, delays } = makeDeps();
    const res = await testApp(deps).request("/api/admin/login", jsonInit({ password: "fake-any-password" }), {
      ADMIN_PASSWORD: value,
    });
    await expectInternal(res);
    expect(delays).toEqual([]);
    expectNoSecretsLogged();
  });

  it("submitting an empty password against an empty ADMIN_PASSWORD returns 500, never 200", async () => {
    const res = await testApp().request("/api/admin/login", jsonInit({ password: "" }), { ADMIN_PASSWORD: "" });
    await expectInternal(res);
  });

  it("player login still works", async () => {
    const res = await testApp().request("/api/login", jsonInit({ password: PLAYER_PASSWORD }), {
      ADMIN_PASSWORD: undefined,
    });
    expect(res.status).toBe(200);
  });
});

describe("§3 missing or short SESSION_SECRET", () => {
  const badSecrets: Array<[string, unknown]> = [...missing, ["31 characters (under the 32 minimum)", SHORT_SECRET]];

  it.each(badSecrets)("player login returns 500 when the secret is %s", async (_n, value) => {
    const { deps, delays } = makeDeps();
    const res = await testApp(deps).request("/api/login", jsonInit({ password: PLAYER_PASSWORD }), {
      SESSION_SECRET: value,
    });
    await expectInternal(res);
    expect(delays).toEqual([]);
    expectNoSecretsLogged();
  });

  it.each(badSecrets)("admin login returns 500 when the secret is %s", async (_n, value) => {
    const { deps, delays } = makeDeps();
    const res = await testApp(deps).request("/api/admin/login", jsonInit({ password: ADMIN_PASSWORD }), {
      SESSION_SECRET: value,
    });
    await expectInternal(res);
    expect(delays).toEqual([]);
  });

  it.each(badSecrets)("a protected route returns 500, not 401, with no cookie when the secret is %s", async (_n, value) => {
    const res = await testApp().request("/api/session", {}, { SESSION_SECRET: value });
    await expectInternal(res);
  });

  it.each(badSecrets)("a protected route returns 500, not 401, with a cookie when the secret is %s", async (_n, value) => {
    // Sign with the same (short) value where possible, so only the length rule can reject it.
    const secret = typeof value === "string" && value !== "" ? value : SESSION_SECRET;
    const cookie = `session=${await signSession({ role: "player", exp: NOW + 60_000 }, secret)}`;
    const res = await testApp().request("/api/session", withCookie(cookie), { SESSION_SECRET: value });
    await expectInternal(res);
    expectNoSecretsLogged();
  });

  it("a secret of exactly 32 characters is accepted", async () => {
    expect(MIN_LENGTH_SECRET).toHaveLength(32);
    const env: EnvOverride = { SESSION_SECRET: MIN_LENGTH_SECRET };
    const { request } = testApp();
    const login = await request("/api/login", jsonInit({ password: PLAYER_PASSWORD }), env);
    expect(login.status).toBe(200);
    const cookie = await cookieFor("player", { secret: MIN_LENGTH_SECRET });
    const res = await request("/api/session", withCookie(cookie), env);
    expect(res.status).toBe(200);
  });
});

describe("§2 §10 GET /api/health with all secrets missing", () => {
  it.each(missing)("returns 200 when all three are %s", async (_n, value) => {
    const res = await testApp().request("/api/health", {}, {
      PLAYER_PASSWORD: value,
      ADMIN_PASSWORD: value,
      SESSION_SECRET: value,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, env: "local" });
  });
});
