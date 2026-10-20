import { describe, expect, it } from "vitest";
import { base64urlDecode, base64urlEncode, hmacSign } from "../src/worker/auth/crypto";
import {
  ADMIN_TTL_MS,
  MIN_SESSION_SECRET_LENGTH,
  PLAYER_TTL_MS,
  SESSION_COOKIE,
  signSession,
  verifySession,
} from "../src/worker/auth/session";
import { NOW, SESSION_SECRET } from "./helpers/auth";

const OTHER_SECRET = "fake-other-session-secret-for-tests-only";

function encodeJson(value: unknown): string {
  return base64urlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

/** Builds a correctly signed token around an arbitrary payload part. */
async function signRaw(payloadPart: string, secret = SESSION_SECRET): Promise<string> {
  return `${payloadPart}.${await hmacSign(secret, payloadPart)}`;
}

describe("§3 session constants", () => {
  it("uses the cookie name, lifetimes and secret length from the plan", () => {
    expect(SESSION_COOKIE).toBe("session");
    expect(PLAYER_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(ADMIN_TTL_MS).toBe(12 * 60 * 60 * 1000);
    expect(MIN_SESSION_SECRET_LENGTH).toBe(32);
  });
});

describe("§3 signed session token format", () => {
  it("is base64url(JSON {role, exp}) + '.' + base64url(HMAC-SHA256(secret, payloadPart))", async () => {
    const exp = NOW + PLAYER_TTL_MS;
    const token = await signSession({ role: "player", exp }, SESSION_SECRET);
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    const [payloadPart = "", sigPart = ""] = parts;
    expect(payloadPart).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sigPart).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(new TextDecoder().decode(base64urlDecode(payloadPart)))).toEqual({ role: "player", exp });
    expect(sigPart).toBe(await hmacSign(SESSION_SECRET, payloadPart));
  });
});

describe("§3 session round-trip", () => {
  it.each(["player", "admin"] as const)("verifies a %s session it signed", async (role) => {
    const exp = NOW + 60_000;
    const token = await signSession({ role, exp }, SESSION_SECRET);
    expect(await verifySession(token, SESSION_SECRET, NOW)).toEqual({ role, exp });
  });
});

describe("§3 session tampering", () => {
  it("rejects a payload re-encoded as admin with the original signature", async () => {
    const exp = NOW + PLAYER_TTL_MS;
    const token = await signSession({ role: "player", exp }, SESSION_SECRET);
    const sig = token.split(".")[1];
    const forged = `${encodeJson({ role: "admin", exp })}.${sig}`;
    expect(await verifySession(forged, SESSION_SECRET, NOW)).toBeNull();
  });

  it("rejects a payload with a pushed-out exp and the original signature", async () => {
    const token = await signSession({ role: "player", exp: NOW + 1000 }, SESSION_SECRET);
    const sig = token.split(".")[1];
    const forged = `${encodeJson({ role: "player", exp: NOW + 10 * PLAYER_TTL_MS })}.${sig}`;
    expect(await verifySession(forged, SESSION_SECRET, NOW)).toBeNull();
  });

  it("rejects a flipped signature character", async () => {
    const token = await signSession({ role: "player", exp: NOW + 1000 }, SESSION_SECRET);
    const [payload = "", sig = ""] = token.split(".");
    // Flip the first character: the last one may only carry unused padding bits.
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(await verifySession(`${payload}.${flipped}`, SESSION_SECRET, NOW)).toBeNull();
  });

  it("rejects swapped parts", async () => {
    const token = await signSession({ role: "player", exp: NOW + 1000 }, SESSION_SECRET);
    const [payload = "", sig = ""] = token.split(".");
    expect(await verifySession(`${sig}.${payload}`, SESSION_SECRET, NOW)).toBeNull();
  });

  it("rejects a token with the signature removed or emptied", async () => {
    const token = await signSession({ role: "player", exp: NOW + 1000 }, SESSION_SECRET);
    const [payload = ""] = token.split(".");
    expect(await verifySession(payload, SESSION_SECRET, NOW)).toBeNull();
    expect(await verifySession(`${payload}.`, SESSION_SECRET, NOW)).toBeNull();
  });

  it("rejects a token with an extra segment appended", async () => {
    const token = await signSession({ role: "player", exp: NOW + 1000 }, SESSION_SECRET);
    expect(await verifySession(`${token}.x`, SESSION_SECRET, NOW)).toBeNull();
  });
});

describe("§3 session secret rotation", () => {
  it("rejects a token signed with a different secret", async () => {
    const token = await signSession({ role: "admin", exp: NOW + 1000 }, OTHER_SECRET);
    expect(await verifySession(token, SESSION_SECRET, NOW)).toBeNull();
  });
});

describe("§3 session expiry boundaries (UTC epoch ms)", () => {
  it("rejects exp < now", async () => {
    const token = await signSession({ role: "player", exp: NOW - 1 }, SESSION_SECRET);
    expect(await verifySession(token, SESSION_SECRET, NOW)).toBeNull();
  });

  it("rejects exp === now", async () => {
    const token = await signSession({ role: "player", exp: NOW }, SESSION_SECRET);
    expect(await verifySession(token, SESSION_SECRET, NOW)).toBeNull();
  });

  it("accepts exp === now + 1", async () => {
    const token = await signSession({ role: "player", exp: NOW + 1 }, SESSION_SECRET);
    expect(await verifySession(token, SESSION_SECRET, NOW)).toEqual({ role: "player", exp: NOW + 1 });
  });

  it("uses the injected now, not the wall clock", async () => {
    const exp = Date.UTC(2001, 0, 1);
    const token = await signSession({ role: "player", exp }, SESSION_SECRET);
    expect(await verifySession(token, SESSION_SECRET, exp - 1)).toEqual({ role: "player", exp });
    expect(await verifySession(token, SESSION_SECRET, exp)).toBeNull();
  });
});

describe("§3 session payload validation (correctly signed but invalid)", () => {
  const cases: Array<[string, () => string]> = [
    ["unknown role", () => encodeJson({ role: "superuser", exp: NOW + 1000 })],
    ["missing role", () => encodeJson({ exp: NOW + 1000 })],
    ["role with different case", () => encodeJson({ role: "Admin", exp: NOW + 1000 })],
    ["missing exp", () => encodeJson({ role: "player" })],
    ["exp as a string", () => encodeJson({ role: "player", exp: String(NOW + 1000) })],
    ["exp null (Infinity/NaN serialize to null)", () => encodeJson({ role: "player", exp: Infinity })],
    ["exp as an object", () => encodeJson({ role: "player", exp: { n: NOW + 1000 } })],
    ["payload is JSON null", () => encodeJson(null)],
    ["payload is a JSON array", () => encodeJson(["player", NOW + 1000])],
    ["payload is a JSON string", () => encodeJson("player")],
    ["payload is not JSON", () => base64urlEncode(new TextEncoder().encode("not json"))],
    ["payload is not base64url", () => "!!not-base64!!"],
  ];

  it.each(cases)("returns null for %s", async (_name, payload) => {
    const token = await signRaw(payload());
    expect(await verifySession(token, SESSION_SECRET, NOW)).toBeNull();
  });

  it("returns null for a token over 1024 characters even if correctly signed", async () => {
    const token = await signRaw(encodeJson({ role: "player", exp: NOW + 1000, pad: "x".repeat(1100) }));
    expect(token.length).toBeGreaterThan(1024);
    expect(await verifySession(token, SESSION_SECRET, NOW)).toBeNull();
  });
});

describe("§3 session malformed input never throws", () => {
  const inputs = [
    "",
    ".",
    "..",
    "abc",
    "a.",
    ".b",
    "a.b",
    "!!!.@@@",
    "a b.c d",
    "%E0%A4%A.x",
    "\u0000.\u0000",
    "🎲.🎲",
    "x".repeat(1025),
    `${"A".repeat(600)}.${"A".repeat(600)}`,
    "x".repeat(100_000),
  ];

  it.each(inputs.map((s) => [s.length > 40 ? `${s.slice(0, 20)}… (${s.length} chars)` : JSON.stringify(s), s]))(
    "resolves to null for %s",
    async (_label, input) => {
      await expect(verifySession(input, SESSION_SECRET, NOW)).resolves.toBeNull();
    },
  );
});
