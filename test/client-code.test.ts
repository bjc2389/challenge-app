// SPEC.md §4: codes are 5 characters from ABCDEFGHJKMNPQRSTUVWXYZ23456789, joined by
// entering them on the home screen, case-insensitive. §9 home: Join by code.
import { describe, expect, it } from "vitest";
import { CODE_ALPHABET, CODE_LENGTH, normalizeCodeInput } from "../src/client/game/code";

describe("§4 code constants", () => {
  it("match the spec", () => {
    expect(CODE_ALPHABET).toBe("ABCDEFGHJKMNPQRSTUVWXYZ23456789");
    expect(CODE_LENGTH).toBe(5);
  });
});

describe("§4 §9 normalizeCodeInput: accepted input", () => {
  it.each([
    ["exact", "ABCDE"],
    ["lowercase with surrounding spaces", " abcde "],
    ["with a dash", "ab-cde"],
    ["with an inner space", "AB CDE"],
    ["a full link", "https://x.example/g/abcde"],
    ["a full link with a trailing slash", "https://x.example/g/abcde/"],
    ["a path with a query", "/g/ABCDE?x=1"],
    ["a path with a hash", "/g/abcde#top"],
    ["surrounding whitespace incl. tab and newline", "\tABCDE\n"],
  ])("%s (%j) gives ABCDE", (_name, raw) => {
    expect(normalizeCodeInput(raw)).toEqual({ ok: true, code: "ABCDE" });
  });

  it("every alphabet character is accepted", () => {
    const padded = CODE_ALPHABET + CODE_ALPHABET.slice(0, 4); // 35 = 7 codes of 5
    for (let i = 0; i < padded.length; i += 5) {
      const code = padded.slice(i, i + 5);
      expect(normalizeCodeInput(code.toLowerCase())).toEqual({ ok: true, code });
    }
  });
});

describe("§4 §9 normalizeCodeInput: rejected input", () => {
  it.each([
    ["empty", ""],
    ["only spaces", "   "],
    ["too short", "ABCD"],
    ["too long", "ABCDEF"],
    ["contains O", "ABCDO"],
    ["contains 0", "ABCD0"],
    ["contains 1", "ABCD1"],
    ["contains I", "ABCDI"],
    ["contains L", "ABCDL"],
    ["contains lowercase o", "abcdo"],
    ["contains lowercase l", "abcdl"],
    ["contains punctuation", "AB_DE"],
    ["a link with no code", "https://x.example/g/"],
    ["a link with a bad code", "https://x.example/g/ABC0E"],
    ["a link with a short code", "/g/ABCD?x=1"],
  ])("%s (%j)", (_name, raw) => {
    const r = normalizeCodeInput(raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(typeof r.message).toBe("string");
    expect(r.message.length).toBeGreaterThan(0);
    expect(r.message).toContain("5");
  });
});
