import { useEffect, useState } from "preact/hooks";
import { apiFetch } from "../api";

type Health = { ok: boolean; env: string };

export function Home() {
  const [health, setHealth] = useState<Health | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // /api/session redirects to /login when there's no valid session.
    apiFetch("/api/session")
      .then(() => apiFetch<Health>("/api/health"))
      .then(setHealth)
      .catch(() => setFailed(true));
  }, []);

  return (
    <main>
      <h1>Challenge</h1>
      <p>{failed ? "API unreachable" : health ? `API ok (${health.env})` : "Checking API…"}</p>
    </main>
  );
}
