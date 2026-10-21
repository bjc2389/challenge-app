// SPEC.md §9 screens and §4 (game URL /g/<code>, codes case-insensitive). M4 client routing.
import { describe, expect, it } from "vitest";
import { matchRoute } from "../src/client/routes";

describe("§9 matchRoute: fixed screens", () => {
  it.each([
    ["/", { name: "home" }],
    ["/login", { name: "login" }],
    ["/admin", { name: "admin" }],
    ["/history", { name: "history" }],
  ])("%s", (path, route) => {
    expect(matchRoute(path)).toEqual(route);
  });
});

describe("§4 §9 matchRoute: /g/:code", () => {
  it("an exact uppercase code is canonical", () => {
    expect(matchRoute("/g/ABCDE")).toEqual({ name: "game", code: "ABCDE", canonical: true });
  });

  it("digits from the alphabet are accepted", () => {
    expect(matchRoute("/g/AB234")).toEqual({ name: "game", code: "AB234", canonical: true });
  });

  it.each(["/g/abcde", "/g/AbCdE", "/g/abCDE"])("%s is uppercased and not canonical (codes are case-insensitive)", (path) => {
    expect(matchRoute(path)).toEqual({ name: "game", code: "ABCDE", canonical: false });
  });

  it.each([
    ["too short", "/g/ABCD"],
    ["too long", "/g/ABCDEF"],
    ["contains 0", "/g/ABCD0"],
    ["contains 1", "/g/ABCD1"],
    ["contains O", "/g/ABCDO"],
    ["contains I", "/g/ABCDI"],
    ["contains L", "/g/ABCDL"],
    ["lowercase l", "/g/abcdl"],
    ["punctuation", "/g/AB-DE"],
  ])("an invalid code (%s) gives the game route with code null", (_name, path) => {
    expect(matchRoute(path)).toEqual({ name: "game", code: null, canonical: false });
  });

  it("tolerates a single trailing slash", () => {
    const r = matchRoute("/g/ABCDE/");
    expect(r.name).toBe("game");
    expect(r).toMatchObject({ code: "ABCDE" });
  });
});

describe("§9 matchRoute: /history/:code", () => {
  it("a valid code", () => {
    expect(matchRoute("/history/ABCDE")).toEqual({ name: "historyGame", code: "ABCDE" });
  });

  it("an invalid code gives code null", () => {
    expect(matchRoute("/history/ABC")).toEqual({ name: "historyGame", code: null });
  });

  it("tolerates a single trailing slash", () => {
    expect(matchRoute("/history/ABCDE/")).toEqual({ name: "historyGame", code: "ABCDE" });
  });
});

describe("§9 matchRoute: trailing slash", () => {
  it.each([
    ["/history/", { name: "history" }],
    ["/login/", { name: "login" }],
    ["/admin/", { name: "admin" }],
  ])("%s", (path, route) => {
    expect(matchRoute(path)).toEqual(route);
  });
});

describe("§9 matchRoute: anything else is notFound", () => {
  it.each([
    "/nope",
    "/games",
    "/g/ABCDE/extra",
    "/history/ABCDE/extra",
    "/history//",
    "/g/ABCDE//",
    "/login/extra",
    "/admin/games",
  ])("%s", (path) => {
    expect(matchRoute(path)).toEqual({ name: "notFound" });
  });
});
