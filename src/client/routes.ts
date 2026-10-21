// Client routes (SPEC.md §9). Pure, so it can be unit-tested without a DOM.
import { isCode } from "./game/code";

export type Route =
  | { name: "home" }
  | { name: "login" }
  | { name: "admin" }
  | { name: "game"; code: string | null; canonical: boolean }
  | { name: "history" }
  | { name: "historyGame"; code: string | null }
  | { name: "notFound" };

const FIXED: Record<string, Route> = {
  "/": { name: "home" },
  "/login": { name: "login" },
  "/admin": { name: "admin" },
  "/history": { name: "history" },
};

export function matchRoute(rawPath: string): Route {
  const path = rawPath.length > 1 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  const fixed = FIXED[path];
  if (fixed) return fixed;

  const game = /^\/g\/([^/]+)$/.exec(path);
  if (game) {
    const segment = game[1]!;
    const code = segment.toUpperCase();
    // Non-canonical paths (lowercase, trailing slash) are rewritten by the page.
    return isCode(code)
      ? { name: "game", code, canonical: segment === code && path === rawPath }
      : { name: "game", code: null, canonical: false };
  }

  const history = /^\/history\/([^/]+)$/.exec(path);
  if (history) {
    const code = history[1]!.toUpperCase();
    return { name: "historyGame", code: isCode(code) ? code : null };
  }
  return { name: "notFound" };
}
