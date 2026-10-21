// The last game this phone opened, for "Resume" on Home. Browser storage can be
// unavailable (private mode), so every access is guarded.
const KEY = "challenge:lastGame";

export function rememberGame(code: string) {
  try {
    localStorage.setItem(KEY, code);
  } catch {
    // Not available: Resume just won't show.
  }
}

export function lastGame(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
