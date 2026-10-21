import { ApiError } from "./apiError";
import { navigate } from "./router";

export { ApiError };

type Options = { redirectOn401?: boolean };

// Every API call goes through here. A 401 sends the user to /login and brings
// them back afterwards, unless the caller handles it (the login forms do).
export async function apiFetch<T>(path: string, init?: RequestInit, { redirectOn401 = true }: Options = {}): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(path, { ...init, headers });
  if (res.ok) return (await res.json()) as T;

  const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (res.status === 401 && redirectOn401) {
    navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  }
  throw new ApiError(res.status, body?.error ?? "unknown", body?.message ?? `HTTP ${res.status}`);
}
