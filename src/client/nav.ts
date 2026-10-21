// Any fixed origin works here: it only lets the URL parser resolve the path.
const BASE = "http://app.invalid";

/**
 * Where a 401 sends the user: the login page, coming back here afterwards. Null on
 * the pages that handle their own login, so they never redirect to themselves.
 */
export function loginRedirectPath(
  pathname: string,
  search: string,
): string | null {
  if (pathname === "/login" || pathname === "/admin") return null;
  return `/login?next=${encodeURIComponent(pathname + search)}`;
}

// Where to go after logging in. Only same-origin paths are allowed, so a crafted
// ?next= link can't send someone to another site. Parsing (rather than only
// checking the string) catches inputs the browser would rewrite, such as a tab
// inside "//".
export function safeNextPath(raw: string | null): string {
  if (
    !raw ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.includes("\\")
  )
    return "/";
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return "/";
  }
  // Dot segments are removed while parsing, so "/.//evil" only becomes "//evil" here.
  if (
    url.origin !== BASE ||
    url.pathname.startsWith("//") ||
    url.pathname === "/login" ||
    url.pathname === "/admin"
  ) {
    return "/";
  }
  return url.pathname + url.search + url.hash;
}
