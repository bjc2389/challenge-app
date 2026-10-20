// Any fixed origin works here: it only lets the URL parser resolve the path.
const BASE = "http://app.invalid";

// Where to go after logging in. Only same-origin paths are allowed, so a crafted
// ?next= link can't send someone to another site. Parsing (rather than only
// checking the string) catches inputs the browser would rewrite, such as a tab
// inside "//".
export function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return "/";
  }
  if (url.origin !== BASE || url.pathname === "/login" || url.pathname === "/admin") return "/";
  return url.pathname + url.search + url.hash;
}
