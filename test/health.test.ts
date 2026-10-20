import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { PLAYER_TTL_MS } from "../src/worker/auth/session";
import { cookieFor } from "./helpers/auth";

describe("§10 GET /api/health", () => {
  it("returns ok and the environment name", async () => {
    const res = await exports.default.fetch("http://example.com/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, env: "local" });
  });

  it("returns a JSON 404 for unknown API routes to a logged-in player", async () => {
    // The deployed entry point uses the real clock, so the cookie must expire in the future.
    const cookie = await cookieFor("player", { exp: Date.now() + PLAYER_TTL_MS });
    const res = await exports.default.fetch("http://example.com/api/nope", { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", message: "Not found" });
  });

  it("returns 401 for unknown API routes without a session (§3: auth runs before routing)", async () => {
    const res = await exports.default.fetch("http://example.com/api/nope");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", message: "Log in to continue" });
  });
});
