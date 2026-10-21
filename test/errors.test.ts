import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleError } from "../src/worker/index";

describe("handleError", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns a generic JSON 500 without leaking the error", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = new Hono()
      .get("/boom", () => {
        throw new Error("db password leaked in stack");
      })
      .onError(handleError);

    const res = await app.request("/boom");

    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "internal", message: "Something went wrong" });
    expect(body).not.toContain("leaked");
    expect(logged).toHaveBeenCalledOnce();
  });
});
