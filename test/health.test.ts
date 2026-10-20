import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /api/health", () => {
  it("returns ok and the environment name", async () => {
    const res = await exports.default.fetch("http://example.com/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, env: "local" });
  });

  it("returns a JSON 404 for unknown API routes", async () => {
    const res = await exports.default.fetch("http://example.com/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", message: "Not found" });
  });
});
