import { describe, expect, it } from "vitest";
import { safeNextPath } from "../src/client/nav";

describe("§3 §9 safeNextPath (redirect target after /login)", () => {
  it.each(["/g/ABCDE?x=1", "/history", "/"])("keeps the same-origin path %j", (path) => {
    expect(safeNextPath(path)).toBe(path);
  });

  it.each([
    ["protocol-relative URL", "//evil.example"],
    ["backslash trick", "/\\evil"],
    ["absolute URL", "https://evil.example"],
    ["javascript: URL", "javascript:x"],
    ["the login page", "/login"],
    ["the admin page", "/admin"],
    ["an empty string", ""],
    ["a tab inside //", "/\t/evil.example"],
    ["a newline inside //", "/\n/evil.example"],
    ["the login page with a query", "/login?next=/admin"],
  ])("returns / for %s (%j)", (_name, raw) => {
    expect(safeNextPath(raw)).toBe("/");
  });

  it("returns / for null", () => {
    expect(safeNextPath(null)).toBe("/");
  });
});
