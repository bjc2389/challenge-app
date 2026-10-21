import { afterEach, describe, expect, it, vi } from "vitest";
import {
  base64urlDecode,
  base64urlEncode,
  hmacSign,
  hmacVerify,
  safeEqual,
} from "../src/worker/auth/crypto";

const SECRET_A = "fake-secret-a-for-crypto-tests";
const SECRET_B = "fake-secret-b-for-crypto-tests";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe("§3 base64url helpers", () => {
  it("encodes with the URL-safe alphabet and no padding", () => {
    expect(base64urlEncode(new Uint8Array([]))).toBe("");
    expect(base64urlEncode(new TextEncoder().encode("Man"))).toBe("TWFu");
    expect(base64urlEncode(new TextEncoder().encode("Ma"))).toBe("TWE");
    // 0xfb 0xff is "+/8=" in standard base64.
    expect(base64urlEncode(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  });

  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    const encoded = base64urlEncode(bytes);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Array.from(base64urlDecode(encoded))).toEqual(Array.from(bytes));
  });

  it("decodes URL-safe input", () => {
    expect(Array.from(base64urlDecode("-_8"))).toEqual([0xfb, 0xff]);
    expect(new TextDecoder().decode(base64urlDecode("TWFu"))).toBe("Man");
  });

  it.each(["!!!!", "ab$c", "A", "AAAAA", "ab cd", "+/8", "a.b"])("throws on invalid input %j", (s) => {
    expect(() => base64urlDecode(s)).toThrow();
  });
});

describe("§3 constant-time comparison (safeEqual)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns true for equal strings", async () => {
    expect(await safeEqual("fake-player-pw", "fake-player-pw")).toBe(true);
    expect(await safeEqual("", "")).toBe(true);
  });

  it("returns false for same-length strings that differ", async () => {
    expect(await safeEqual("fake-abcdef", "fake-abcdeg")).toBe(false);
    expect(await safeEqual("Xfake", "xfake")).toBe(false);
  });

  it("returns false when one is a prefix of the other", async () => {
    expect(await safeEqual("fake-pass", "fake-password")).toBe(false);
    expect(await safeEqual("fake-password", "fake-pass")).toBe(false);
  });

  it("returns false for different lengths", async () => {
    expect(await safeEqual("a", "abcdefghijklmnop")).toBe(false);
  });

  it("returns false for empty against non-empty, in both orders", async () => {
    expect(await safeEqual("", "x")).toBe(false);
    expect(await safeEqual("x", "")).toBe(false);
  });

  it("handles unicode", async () => {
    expect(await safeEqual("fake-pässwörd-🎲", "fake-pässwörd-🎲")).toBe(true);
    expect(await safeEqual("fake-pässwörd-🎲", "fake-passwörd-🎲")).toBe(false);
    // Composed vs decomposed forms are different byte sequences.
    expect(await safeEqual("é", "é")).toBe(false);
  });

  it("uses crypto.subtle.timingSafeEqual", async () => {
    const spy = vi.spyOn(crypto.subtle, "timingSafeEqual");
    await safeEqual("fake-one", "fake-two-longer");
    expect(spy).toHaveBeenCalled();
  });
});

describe("§3 HMAC-SHA256 signing", () => {
  it("matches the RFC 4231 test case 2 vector", async () => {
    const sig = await hmacSign("Jefe", "what do ya want for nothing?");
    expect(Array.from(base64urlDecode(sig))).toEqual(
      Array.from(hexToBytes("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843")),
    );
  });

  it("is deterministic", async () => {
    expect(await hmacSign(SECRET_A, "payload")).toBe(await hmacSign(SECRET_A, "payload"));
  });

  it("differs per secret and per data", async () => {
    const base = await hmacSign(SECRET_A, "payload");
    expect(await hmacSign(SECRET_B, "payload")).not.toBe(base);
    expect(await hmacSign(SECRET_A, "payload2")).not.toBe(base);
  });

  it("produces a base64url-encoded 32-byte signature", async () => {
    const sig = await hmacSign(SECRET_A, "payload");
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(base64urlDecode(sig).length).toBe(32);
  });

  it("hmacVerify accepts a valid signature", async () => {
    const sig = await hmacSign(SECRET_A, "payload");
    expect(await hmacVerify(SECRET_A, "payload", sig)).toBe(true);
  });

  it("hmacVerify rejects a wrong secret, wrong data, or altered signature", async () => {
    const sig = await hmacSign(SECRET_A, "payload");
    expect(await hmacVerify(SECRET_B, "payload", sig)).toBe(false);
    expect(await hmacVerify(SECRET_A, "payload!", sig)).toBe(false);
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(await hmacVerify(SECRET_A, "payload", flipped)).toBe(false);
    // A truncated (but well-formed) signature must not verify.
    expect(await hmacVerify(SECRET_A, "payload", sig.slice(0, 20))).toBe(false);
  });
});
