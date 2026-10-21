// SPEC.md §4 Setup: names are 1–24 characters after trimming and must differ (ignoring case).
// Plan detail: length in code points; no C0, C1 or DEL control characters; non-strings fail.
import { describe, expect, it } from "vitest";
import { validateTeamNames } from "../src/worker/game/names";

function expectInvalid(a: unknown, b: unknown) {
  const r = validateTeamNames(a, b);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(typeof r.message).toBe("string");
    expect(r.message.length).toBeGreaterThan(0);
  }
}

describe("§4 validateTeamNames: valid names", () => {
  it("accepts two distinct names", () => {
    expect(validateTeamNames("Red", "Blue")).toEqual({ ok: true, names: ["Red", "Blue"] });
  });

  it("trims both names", () => {
    expect(validateTeamNames("  Red Team ", "\tBlue\n")).toEqual({ ok: true, names: ["Red Team", "Blue"] });
  });

  it("accepts the defaults", () => {
    expect(validateTeamNames("Team 1", "Team 2")).toEqual({ ok: true, names: ["Team 1", "Team 2"] });
  });

  it("accepts 1 character and exactly 24 characters", () => {
    const a = "x";
    const b = "y".repeat(24);
    expect(validateTeamNames(a, b)).toEqual({ ok: true, names: [a, b] });
  });

  it("counts length in code points: 24 astral emoji pass", () => {
    const emoji = "\u{1F37A}".repeat(24); // 48 UTF-16 units, 24 code points
    expect(validateTeamNames(emoji, "Blue")).toEqual({ ok: true, names: [emoji, "Blue"] });
  });

  it("measures length after trimming", () => {
    const name = "z".repeat(24);
    expect(validateTeamNames(`   ${name}   `, "Blue")).toEqual({ ok: true, names: [name, "Blue"] });
  });

  it("allows names that differ only in inner spacing", () => {
    expect(validateTeamNames("Red Team", "RedTeam")).toEqual({ ok: true, names: ["Red Team", "RedTeam"] });
  });
});

describe("§4 validateTeamNames: invalid names", () => {
  it.each([
    ["empty first", "", "Blue"],
    ["empty second", "Red", ""],
    ["blank first", "   ", "Blue"],
    ["blank second", "Red", "\t \n"],
    ["25 characters", "a".repeat(25), "Blue"],
    ["25 characters (second)", "Red", "b".repeat(25)],
    ["25 astral emoji", "\u{1F37A}".repeat(25), "Blue"],
  ])("rejects %s", (_name, a, b) => {
    expectInvalid(a, b);
  });

  it.each([
    ["NUL", "Red\u0000"],
    ["inner tab", "Red\tTeam"],
    ["inner newline", "Red\nTeam"],
    ["inner carriage return", "Red\rTeam"],
    ["escape", "Red\u001bTeam"],
    ["unit separator", "Red\u001fTeam"],
    ["DEL", "Red\u007fTeam"],
    ["C1 start", "Red\u0080Team"],
    ["C1 NEL", "Red\u0085Team"],
    ["C1 end", "Red\u009fTeam"],
  ])("rejects a control character: %s", (_name, bad) => {
    expectInvalid(bad, "Blue");
    expectInvalid("Blue", bad);
  });

  it.each([
    ["identical", "Red", "Red"],
    ["case only", "Red", "rED"],
    ["equal after trimming", "  Red ", "RED"],
    ["non-ASCII case", "Équipe", "équipe"],
  ])("rejects names that match ignoring case: %s", (_name, a, b) => {
    expectInvalid(a, b);
  });

  it.each([
    ["number", 1],
    ["null", null],
    ["undefined", undefined],
    ["object", { name: "Red" }],
    ["array", ["Red"]],
    ["boolean", true],
  ])("rejects a non-string (%s) in either position", (_name, value) => {
    expectInvalid(value, "Blue");
    expectInvalid("Blue", value);
  });
});
