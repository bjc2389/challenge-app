import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import type { Env } from "../env";
import { MissingSecretError } from "../errors";
import { base64urlDecode, base64urlEncode, hmacSign, hmacVerify } from "./crypto";

export type Role = "player" | "admin";
export type Session = { role: Role; exp: number };

export const SESSION_COOKIE = "session";
export const PLAYER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;
export const MIN_SESSION_SECRET_LENGTH = 32;
const MAX_TOKEN_LENGTH = 1024;

const COOKIE_OPTIONS: CookieOptions = { httpOnly: true, secure: true, sameSite: "Lax", path: "/" };

// Token format: base64url(JSON {role, exp}) "." base64url(HMAC-SHA256 of the first part).
// exp is UTC epoch milliseconds. Expiry is fixed at login and never extended.
export async function signSession(session: Session, secret: string): Promise<string> {
  const payload = base64urlEncode(
    new TextEncoder().encode(JSON.stringify({ role: session.role, exp: session.exp })),
  );
  return `${payload}.${await hmacSign(secret, payload)}`;
}

// Returns null for anything that isn't a valid, unexpired session. Never throws.
export async function verifySession(token: string, secret: string, now: number): Promise<Session | null> {
  try {
    if (token.length > MAX_TOKEN_LENGTH) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payload, signature] = parts as [string, string];
    if (!payload || !signature || !(await hmacVerify(secret, payload, signature))) return null;

    const value: unknown = JSON.parse(new TextDecoder().decode(base64urlDecode(payload)));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { role, exp } = value as Record<string, unknown>;
    if (role !== "player" && role !== "admin") return null;
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= now) return null;
    return { role, exp };
  } catch {
    return null;
  }
}

type AuthEnvVar = "PLAYER_PASSWORD" | "ADMIN_PASSWORD" | "SESSION_SECRET";

// Reads a secret from env, treating unset, empty and too-short values as missing.
export function requireSecret(env: Env, name: AuthEnvVar): string {
  const value: unknown = env[name];
  if (value === undefined) throw new MissingSecretError(name, "not set");
  // A Secrets Store binding, for example, arrives as an object rather than text.
  if (typeof value !== "string") throw new MissingSecretError(name, `not text: ${typeof value}`);
  if (value === "") throw new MissingSecretError(name, "empty");
  if (name === "SESSION_SECRET" && value.length < MIN_SESSION_SECRET_LENGTH) {
    throw new MissingSecretError(name, `shorter than ${MIN_SESSION_SECRET_LENGTH} characters`);
  }
  return value;
}

export async function setSessionCookie(c: Context, session: Session, secret: string, ttlMs: number) {
  setCookie(c, SESSION_COOKIE, await signSession(session, secret), {
    ...COOKIE_OPTIONS,
    maxAge: ttlMs / 1000,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, COOKIE_OPTIONS);
}

export function readSession(c: Context, secret: string, now: number): Promise<Session | null> {
  return verifySession(getCookie(c, SESSION_COOKIE) ?? "", secret, now);
}
