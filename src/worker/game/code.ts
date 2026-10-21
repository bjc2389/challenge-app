import { CODE_ALPHABET, CODE_LENGTH } from "./constants";
import type { RandomInt } from "./types";

export function generateCode(rand: RandomInt): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[rand(CODE_ALPHABET.length)];
  return code;
}

/** Trims and uppercases a code from a URL. Returns null unless it could be a real code. */
export function normalizeCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}
