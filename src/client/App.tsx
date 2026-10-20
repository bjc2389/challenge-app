import { useEffect, useState } from "preact/hooks";

type Health = { ok: boolean; env: string };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => (res.ok ? (res.json() as Promise<Health>) : Promise.reject()))
      .then(setHealth)
      .catch(() => setFailed(true));
  }, []);

  return (
    <main>
      <h1>Challenge</h1>
      <p>
        {failed ? "API unreachable" : health ? `API ok (${health.env})` : "Checking API…"}
      </p>
    </main>
  );
}
