import { useEffect, useState } from "preact/hooks";
import { apiFetch } from "../api";
import { Link } from "../components/Link";
import { normalizeCodeInput } from "../game/code";
import { errorMessage } from "../game/errors";
import { isOver, type GameView } from "../game/types";
import { lastGame } from "../lastGame";
import { navigate } from "../router";

export function Home() {
  const [resume, setResume] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // /api/session redirects to /login when there's no valid session.
    apiFetch("/api/session")
      .then(async () => {
        const code = lastGame();
        if (!code) return;
        const view = await apiFetch<GameView>(`/api/games/${code}`);
        if (!isOver(view)) setResume(view.game.code);
      })
      .catch(() => {});
  }, []);

  const newGame = async () => {
    setCreating(true);
    setError(null);
    try {
      const view = await apiFetch<GameView>("/api/games", { method: "POST" });
      navigate(`/g/${view.game.code}`);
    } catch (err) {
      setError(errorMessage(err));
      setCreating(false);
    }
  };

  const join = (event: Event) => {
    event.preventDefault();
    const result = normalizeCodeInput(joinCode);
    if (!result.ok) return setJoinError(result.message);
    navigate(`/g/${result.code}`);
  };

  const logout = async (event: Event) => {
    event.preventDefault();
    await apiFetch("/api/logout", { method: "POST" }, { redirectOn401: false }).catch(() => {});
    navigate("/login");
  };

  return (
    <main class="stack home">
      <h1>Challenge</h1>
      {resume && (
        <button type="button" class="secondary" onClick={() => navigate(`/g/${resume}`)}>
          Resume game {resume}
        </button>
      )}
      <button type="button" class="big" onClick={newGame} disabled={creating}>
        {creating ? "Creating…" : "New game"}
      </button>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}

      <form class="stack join" onSubmit={join}>
        <label for="join-code">Join by code</label>
        <div class="row">
          <input
            id="join-code"
            value={joinCode}
            autocomplete="off"
            autocapitalize="characters"
            spellcheck={false}
            placeholder="ABCDE"
            aria-describedby={joinError ? "join-error" : undefined}
            onInput={(e) => {
              setJoinCode(e.currentTarget.value);
              setJoinError(null);
            }}
          />
          <button type="submit">Join</button>
        </div>
        {joinError && (
          <p id="join-error" class="error" role="alert">
            {joinError}
          </p>
        )}
      </form>

      <Link href="/history">History</Link>
      <a href="/login" class="quiet" onClick={logout}>
        Log out
      </a>
    </main>
  );
}
