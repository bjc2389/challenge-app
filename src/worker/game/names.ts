import { TEAM_NAME_MAX } from "./constants";

// C0 and C1 control characters and DEL, which includes newlines and tabs.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

type Result = { ok: true; names: [string, string] } | { ok: false; message: string };

// SPEC.md §4: 1–24 characters after trimming, and the two names differ ignoring case.
export function validateTeamNames(a: unknown, b: unknown): Result {
  if (typeof a !== "string" || typeof b !== "string") return { ok: false, message: "Both team names are required" };
  const names: [string, string] = [a.trim(), b.trim()];
  for (const name of names) {
    const length = [...name].length;
    if (length < 1 || length > TEAM_NAME_MAX) {
      return { ok: false, message: `Team names must be 1–${TEAM_NAME_MAX} characters` };
    }
    if (CONTROL_CHARS.test(name)) return { ok: false, message: "Team names can't contain control characters" };
  }
  if (names[0].toLowerCase() === names[1].toLowerCase()) return { ok: false, message: "Team names must be different" };
  return { ok: true, names };
}
