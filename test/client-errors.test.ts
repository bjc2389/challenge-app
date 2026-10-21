// SPEC.md §10 error codes ({error, message}) turned into player-facing text (M4).
// 500 bodies never carry details, so `internal` maps to a fixed message.
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/client/apiError";
import { errorMessage } from "../src/client/game/errors";

describe("§10 ApiError", () => {
  it("carries status, code and message", () => {
    const err = new ApiError(409, "busy", "Try again");
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(409);
    expect(err.code).toBe("busy");
    expect(err.message).toBe("Try again");
  });
});

describe("§10 errorMessage: known codes", () => {
  it.each([
    [404, "not_found", "No game with that code"],
    [409, "invalid_state", "That can't be done right now"],
    [409, "game_over", "This game is over"],
    [409, "final_locked", "Finish every other task first"],
    [409, "final_not_undoable", "The final task can't be undone"],
    [409, "busy", "Lots of taps at once. Try again."],
  ])("%d %s", (status, code, text) => {
    expect(errorMessage(new ApiError(status, code, "server text"))).toBe(text);
  });
});

describe("§10 errorMessage: server message passes through", () => {
  it("validation (422)", () => {
    expect(errorMessage(new ApiError(422, "validation", "Team names must differ"))).toBe("Team names must differ");
  });

  it("catalog_incomplete (409, §5 names the short category)", () => {
    const msg = "Category Drinks has too few active tasks";
    expect(errorMessage(new ApiError(409, "catalog_incomplete", msg))).toBe(msg);
  });
});

describe("§10 errorMessage: fallbacks", () => {
  it("internal never shows the server message", () => {
    expect(errorMessage(new ApiError(500, "internal", "stack trace here"))).toBe("Something went wrong");
  });

  it("an unknown code", () => {
    expect(errorMessage(new ApiError(418, "teapot", "short and stout"))).toBe("Something went wrong");
  });

  it("a TypeError (fetch network failure)", () => {
    expect(errorMessage(new TypeError("Failed to fetch"))).toBe("Can't reach the server. Check your connection.");
  });

  it.each([
    ["a plain Error", new Error("boom")],
    ["a string", "boom"],
    ["null", null],
    ["undefined", undefined],
    ["an object", { error: "busy" }],
  ])("%s", (_name, err) => {
    expect(errorMessage(err)).toBe("Something went wrong");
  });
});
