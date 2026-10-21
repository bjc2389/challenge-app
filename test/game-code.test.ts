// SPEC.md §4 Create: the game code is 5 characters from ABCDEFGHJKMNPQRSTUVWXYZ23456789.
import { describe, expect, it } from "vitest";
import { generateCode, normalizeCode } from "../src/worker/game/code";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  DEFAULT_TEAM_NAMES,
  GAME_DURATION_MS,
  MAX_CODE_ATTEMPTS,
  TEAM_NAME_MAX,
} from "../src/worker/game/constants";
import { seqRandom } from "./helpers/game";

describe("§4 game constants", () => {
  it("uses the spec's 31-character alphabet and 5-character codes", () => {
    expect(CODE_ALPHABET).toBe("ABCDEFGHJKMNPQRSTUVWXYZ23456789");
    expect(CODE_ALPHABET).toHaveLength(31);
    expect(new Set(CODE_ALPHABET).size).toBe(31);
    for (const ambiguous of ["I", "L", "O", "0", "1"]) expect(CODE_ALPHABET).not.toContain(ambiguous);
    expect(CODE_LENGTH).toBe(5);
  });

  it("caps games at 60 minutes, names at 24, and code attempts at 5", () => {
    expect(GAME_DURATION_MS).toBe(3_600_000);
    expect(TEAM_NAME_MAX).toBe(24);
    expect(DEFAULT_TEAM_NAMES).toEqual(["Team 1", "Team 2"]);
    expect(MAX_CODE_ATTEMPTS).toBe(5);
  });
});

describe("§4 generateCode", () => {
  it("maps each of 5 rand(31) calls, in order, to CODE_ALPHABET[value]", () => {
    const rand = seqRandom([0, 1, 2, 3, 4]);
    expect(generateCode(rand)).toBe("ABCDE");
    expect(rand.calls).toEqual([31, 31, 31, 31, 31]);
    expect(rand.remaining()).toBe(0);
  });

  it("covers the end of the alphabet", () => {
    expect(generateCode(seqRandom([30, 29, 22, 23, 8]))).toBe("98Z2J");
  });

  it("uses exactly 5 values, leaving the rest", () => {
    const rand = seqRandom([7, 7, 7, 7, 7, 0]);
    expect(generateCode(rand)).toBe("HHHHH");
    expect(rand.remaining()).toBe(1);
  });

  it("with real randomness always yields a valid code", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode((max) => Math.floor(Math.random() * max));
      expect(normalizeCode(code)).toBe(code);
    }
  });
});

describe("§4 normalizeCode", () => {
  it.each([
    ["ABCDE", "ABCDE"],
    ["abcde", "ABCDE"],
    ["  hjk9z ", "HJK9Z"],
    ["\tQRS23\n", "QRS23"],
    ["98765", "98765"],
  ])("accepts %j as %s", (input, expected) => {
    expect(normalizeCode(input)).toBe(expected);
  });

  it.each([
    ["empty", ""],
    ["blank", "     "],
    ["too short", "ABCD"],
    ["too long", "ABCDEF"],
    ["contains I", "ABCDI"],
    ["contains L", "ABCDL"],
    ["contains O", "ABCDO"],
    ["contains 0", "ABCD0"],
    ["contains 1", "ABCD1"],
    ["inner space", "AB DE"],
    ["punctuation", "AB-DE"],
    ["non-ASCII letter", "ÀBCDE"],
    ["lowercase ambiguous letter", "abcdl"],
  ])("rejects %s (%j)", (_name, input) => {
    expect(normalizeCode(input)).toBeNull();
  });
});
