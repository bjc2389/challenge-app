import { describe, expect, it } from "vitest";
import { NOW, cookieFor, makeDeps, parseSetCookie, testApp, withCookie } from "./helpers/auth";

async function expectLoggedOut(res: Response) {
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  const cookies = parseSetCookie(res);
  expect(cookies).toHaveLength(1);
  const [cookie] = cookies;
  expect(cookie?.name).toBe("session");
  expect(cookie?.value).toBe("");
  expect(cookie?.attrs["max-age"]).toBe("0");
  expect(cookie?.attrs.path).toBe("/");
  expect(cookie?.attrs.httponly).toBe(true);
  expect(cookie?.attrs.secure).toBe(true);
  expect(String(cookie?.attrs.samesite).toLowerCase()).toBe("lax");
  expect(cookie?.attrs).not.toHaveProperty("domain");
}

describe("§3 §10 logout (POST /api/logout)", () => {
  it("returns 200 {ok: true} and clears the cookie with no cookie sent", async () => {
    await expectLoggedOut(await testApp().request("/api/logout", { method: "POST" }));
  });

  it("clears a valid player session", async () => {
    await expectLoggedOut(await testApp().request("/api/logout", withCookie(await cookieFor("player"), { method: "POST" })));
  });

  it("clears a valid admin session", async () => {
    await expectLoggedOut(await testApp().request("/api/logout", withCookie(await cookieFor("admin"), { method: "POST" })));
  });

  it("works with an expired cookie", async () => {
    const expired = await cookieFor("player", { exp: NOW - 1 });
    await expectLoggedOut(await testApp().request("/api/logout", withCookie(expired, { method: "POST" })));
  });

  it("works with a garbage cookie", async () => {
    await expectLoggedOut(await testApp().request("/api/logout", withCookie("session=not.a-token", { method: "POST" })));
  });

  it("is idempotent across repeated calls and never delays", async () => {
    const { deps, delays } = makeDeps();
    const { request } = testApp(deps);
    await expectLoggedOut(await request("/api/logout", { method: "POST" }));
    await expectLoggedOut(await request("/api/logout", { method: "POST" }));
    expect(delays).toEqual([]);
  });
});
