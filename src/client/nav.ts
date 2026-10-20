// Where to go after logging in. Only same-origin paths are allowed, so a crafted
// ?next= link can't send someone to another site.
export function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  const path = raw.split(/[?#]/)[0];
  if (path === "/login" || path === "/admin") return "/";
  return raw;
}
