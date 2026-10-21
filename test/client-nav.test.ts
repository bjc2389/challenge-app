import { describe, expect, it } from "vitest";
import { loginRedirectPath, safeNextPath } from "../src/client/nav";

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

// §3: "The client sends the user to /login?next=<path> whenever the API returns 401,
// except on /login and /admin, which show their own password form." The encoding
// matches what apiFetch builds: encodeURIComponent(pathname + search).
describe("§3 loginRedirectPath (where a 401 sends the user)", () => {
  it("encodes the current path into ?next=", () => {
    expect(loginRedirectPath("/g/ABCDE", "")).toBe("/login?next=%2Fg%2FABCDE");
  });

  it.each([
    ["/login", ""],
    ["/admin", ""],
    ["/login", "?next=%2Fhistory"],
    ["/admin", "?x=1"],
  ])("returns null on %s%s, which shows its own password form", (pathname, search) => {
    expect(loginRedirectPath(pathname, search)).toBeNull();
  });

  it.each(["/", "/history", "/history/ABCDE", "/g/ABCDE", "/nope"])(
    "round-trips %s?x=1 through safeNextPath",
    (pathname) => {
      const search = "?x=1";
      const result = loginRedirectPath(pathname, search);
      expect(result).not.toBeNull();
      const url = new URL(result as string, "http://app.invalid");
      expect(url.pathname).toBe("/login");
      expect([...url.searchParams.keys()]).toEqual(["next"]);
      expect(safeNextPath(url.searchParams.get("next"))).toBe(pathname + search);
    },
  );
});
