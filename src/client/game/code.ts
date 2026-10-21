// Game codes (SPEC.md §4). Kept equal to the Worker's by test/client-contract.test.ts.
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 5;

const INVALID = `Codes are ${CODE_LENGTH} characters: letters A–Z (no I, L or O) and digits 2–9`;

export function isCode(value: string): boolean {
  return value.length === CODE_LENGTH && [...value].every((ch) => CODE_ALPHABET.includes(ch));
}

/** Reads a typed or pasted code (or a pasted /g/ link) into a canonical code. */
export function normalizeCodeInput(raw: string): { ok: true; code: string } | { ok: false; message: string } {
  let text = raw;
  const link = text.indexOf("/g/");
  if (link !== -1) text = text.slice(link + 3).split(/[/?#]/)[0] ?? "";
  const code = text.replace(/[\s-]/g, "").toUpperCase();
  return isCode(code) ? { ok: true, code } : { ok: false, message: INVALID };
}
