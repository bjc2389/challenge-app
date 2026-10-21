// Shared helpers for the M1 auth tests (SPEC.md §3, §10).
// The fake secret values come from the test bindings in vitest.config.ts via `env`;
// they are never repeated in test files. Signed cookies are generated at runtime.
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { createApp } from "../../src/worker/app";
import {
  ADMIN_TTL_MS,
  PLAYER_TTL_MS,
  SESSION_COOKIE,
  signSession,
  type Role,
} from "../../src/worker/auth/session";

const BINDING_NAMES = ["PLAYER_PASSWORD", "ADMIN_PASSWORD", "SESSION_SECRET"] as const;

for (const name of BINDING_NAMES) {
  const value = env[name];
  if (typeof value !== "string" || value === "") {
    throw new Error(`Test binding ${name} is missing; see vitest.config.ts`);
  }
}

export const PLAYER_PASSWORD = env.PLAYER_PASSWORD as string;
export const ADMIN_PASSWORD = env.ADMIN_PASSWORD as string;
export const SESSION_SECRET = env.SESSION_SECRET as string;

/** Fixed test clock: 2026-10-20T12:00:00Z in UTC epoch ms. */
export const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

import type { Deps } from "../../src/worker/app";
import type { RandomInt } from "../../src/worker/game/types";
import { cryptoRandomInt } from "../../src/worker/random";

export type { Deps };

/**
 * Injected clock, delay and random source.
 * - The clock starts at `opts.now` (default NOW) and only moves through `setNow`/`advance`.
 * - `delays` records every requested delay. With `manualDelay`, each delay stays pending
 *   until `releaseDelays()` is called.
 * - `random` defaults to the real crypto source; tests script it with `seqRandom`.
 */
export function makeDeps(opts: { now?: number; manualDelay?: boolean; random?: RandomInt } = {}) {
  const delays: number[] = [];
  const pending: Array<() => void> = [];
  let current = opts.now ?? NOW;
  const deps: Deps = {
    now: () => current,
    delay(ms: number) {
      delays.push(ms);
      if (opts.manualDelay) return new Promise<void>((resolve) => pending.push(resolve));
      return Promise.resolve();
    },
    randomInt: opts.random ?? cryptoRandomInt,
  };
  return {
    deps,
    delays,
    releaseDelays() {
      for (const resolve of pending.splice(0)) resolve();
    },
    /** Sets the injected clock to `ms` (UTC epoch ms). */
    setNow(ms: number) {
      current = ms;
    },
    /** Moves the injected clock forward by `ms`. */
    advance(ms: number) {
      current += ms;
    },
  };
}

export type EnvOverride = Partial<Record<keyof Cloudflare.Env, unknown>>;

/** App under test with injected deps. Every request gets the full env, with optional overrides. */
export function testApp(deps: Deps = makeDeps().deps) {
  const app = createApp(deps);
  return {
    app,
    async request(path: string, init: RequestInit = {}, envOverride: EnvOverride = {}): Promise<Response> {
      return await app.request(path, init, { ...env, ...envOverride } as Cloudflare.Env);
    },
  };
}

/** A `Cookie` header value carrying a session signed at runtime with the fake secret. */
export async function cookieFor(
  role: Role,
  opts: { exp?: number; secret?: string } = {},
): Promise<string> {
  const exp = opts.exp ?? NOW + (role === "admin" ? ADMIN_TTL_MS : PLAYER_TTL_MS);
  const token = await signSession({ role, exp }, opts.secret ?? SESSION_SECRET);
  return `${SESSION_COOKIE}=${token}`;
}

export type ParsedCookie = {
  name: string;
  value: string;
  /** Attribute names lowercased; flag attributes map to `true`. */
  attrs: Record<string, string | true>;
};

export function parseSetCookie(res: Response): ParsedCookie[] {
  return res.headers.getSetCookie().map((line) => {
    const [pair = "", ...rest] = line.split(";").map((s) => s.trim());
    const eq = pair.indexOf("=");
    const attrs: Record<string, string | true> = {};
    for (const part of rest) {
      if (!part) continue;
      const i = part.indexOf("=");
      if (i === -1) attrs[part.toLowerCase()] = true;
      else attrs[part.slice(0, i).toLowerCase()] = part.slice(i + 1);
    }
    return { name: eq === -1 ? pair : pair.slice(0, eq), value: eq === -1 ? "" : pair.slice(eq + 1), attrs };
  });
}

export function jsonInit(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

export function withCookie(cookie: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string> | undefined), cookie } };
}

/** §10: error bodies are exactly `{error, message}`. */
export async function expectError(res: Response, status: number, error: string, message: string) {
  expect(res.status).toBe(status);
  const body: unknown = await res.json();
  expect(body).toEqual({ error, message });
  expect(Object.keys(body as object).sort()).toEqual(["error", "message"]);
}

/** Asserts a 422 validation error: `{error: "validation", message: <string>}` and nothing else. */
export async function expectValidationError(res: Response) {
  expect(res.status).toBe(422);
  const body = (await res.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["error", "message"]);
  expect(body.error).toBe("validation");
  expect(typeof body.message).toBe("string");
}
