// CLAUDE.md secrets rules and SPEC.md §3: a missing secret logs the variable name and
// why it was rejected, never its value or exact length.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { requireSecret } from "../src/worker/auth/session";
import { MissingSecretError } from "../src/worker/errors";

const SESSION = "SESSION_SECRET" as const;
const PLAYER = "PLAYER_PASSWORD" as const;

function reasonFor(value: unknown, name: typeof SESSION | typeof PLAYER = SESSION): string {
  try {
    requireSecret({ ...env, [name]: value } as Cloudflare.Env, name);
  } catch (err) {
    expect(err).toBeInstanceOf(MissingSecretError);
    return (err as Error).message;
  }
  throw new Error("expected requireSecret to throw");
}

describe("§3 missing-secret log messages say why, without the value", () => {
  it.each([
    ["not set", undefined],
    ["empty", ""],
    ["shorter than 32 characters", "fake-short-secret"],
  ])("SESSION_SECRET %s", (reason, value) => {
    const message = reasonFor(value);
    expect(message).toBe(`Missing or invalid secret: SESSION_SECRET (${reason})`);
    if (typeof value === "string" && value) expect(message).not.toContain(value);
  });

  it("a non-text binding (e.g. a Secrets Store object) reports its type", () => {
    expect(reasonFor({ get: async () => "fake-value" })).toBe("Missing or invalid secret: SESSION_SECRET (not text: object)");
  });

  it("a password only needs to be non-empty", () => {
    expect(reasonFor("", PLAYER)).toBe("Missing or invalid secret: PLAYER_PASSWORD (empty)");
    expect(requireSecret({ ...env, PLAYER_PASSWORD: "x" } as Cloudflare.Env, "PLAYER_PASSWORD")).toBe("x");
  });

  it("a valid SESSION_SECRET is returned as is", () => {
    const value = "fake-session-secret-0123456789abcdef";
    expect(requireSecret({ ...env, SESSION_SECRET: value } as Cloudflare.Env, "SESSION_SECRET")).toBe(value);
  });
});
