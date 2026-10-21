import { useEffect, useState } from "preact/hooks";
import { ApiError, apiFetch } from "../api";
import { adminErrorMessage, catalogSummary, deleteConfirm, gameRow, removeGame, replaceGame, testToggleLabel } from "../admin/view";
import type { AdminCatalog, AdminGame, AdminGameList } from "../admin/types";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Link } from "../components/Link";
import { PasswordForm } from "../components/PasswordForm";
import { navigate } from "../router";

type SessionInfo = { role: "player" | "admin"; exp: number };

const QUIET = { redirectOn401: false };

// SPEC.md §9: admin login, every game (mark as test, delete), and the catalog read-only.
// Not linked from anywhere in the UI.
export function Admin() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    apiFetch<SessionInfo>("/api/session", undefined, QUIET)
      .then((s) => setIsAdmin(s.role === "admin"))
      .catch(() => setIsAdmin(false));
  }, []);

  const logout = async () => {
    await apiFetch("/api/logout", { method: "POST" }, QUIET).catch(() => {});
    navigate("/login");
  };

  return (
    <main class="stack">
      <h1>Admin</h1>
      {isAdmin === null ? null : isAdmin ? (
        <AdminConsole onLoggedOut={() => setIsAdmin(false)} onLogout={logout} />
      ) : (
        <PasswordForm endpoint="/api/admin/login" onSuccess={() => setIsAdmin(true)} />
      )}
    </main>
  );
}

function AdminConsole({ onLoggedOut, onLogout }: { onLoggedOut(): void; onLogout(): void }) {
  const [games, setGames] = useState<AdminGame[] | null>(null);
  const [catalog, setCatalog] = useState<AdminCatalog | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AdminGame | null>(null);

  const fail = (err: unknown) => {
    // The admin session ran out (12 hours) or isn't admin: back to the form.
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return onLoggedOut();
    setError(adminErrorMessage(err));
  };

  useEffect(() => {
    Promise.all([
      apiFetch<AdminGameList>("/api/admin/games", undefined, QUIET),
      apiFetch<AdminCatalog>("/api/admin/catalog", undefined, QUIET),
    ])
      .then(([list, cat]) => {
        setGames(list.items);
        setCatalog(cat);
      })
      .catch(fail);
  }, []);

  const toggleTest = async (game: AdminGame) => {
    setBusy(game.code);
    setError(null);
    try {
      const updated = await apiFetch<AdminGame>(
        `/api/admin/games/${game.code}`,
        { method: "PATCH", body: JSON.stringify({ isTest: !game.isTest }) },
        QUIET,
      );
      setGames((list) => (list ? replaceGame(list, updated) : list));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setGames((list) => (list ? removeGame(list, game.code) : list));
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (game: AdminGame) => {
    setConfirmDelete(null);
    setBusy(game.code);
    setError(null);
    try {
      await apiFetch(`/api/admin/games/${game.code}`, { method: "DELETE" }, QUIET);
      setGames((list) => (list ? removeGame(list, game.code) : list));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setGames((list) => (list ? removeGame(list, game.code) : list));
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const dialog = confirmDelete && deleteConfirm(confirmDelete);

  return (
    <>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}

      <section class="stack" aria-labelledby="games-title">
        <h2 id="games-title">Games</h2>
        {games === null ? (
          <p aria-live="polite">Loading…</p>
        ) : games.length === 0 ? (
          <p>No games yet.</p>
        ) : (
          <ul class="admin-list">
            {games.map((game) => {
              const row = gameRow(game);
              return (
                <li class="admin-game" key={game.code}>
                  <div class="admin-game-head">
                    <Link href={`/g/${game.code}`} class="admin-code">
                      {game.code}
                    </Link>
                    {row.isTest && <span class="tag-test">Test</span>}
                  </div>
                  <span class="admin-meta">
                    {row.date} · {row.statusLabel}
                  </span>
                  <span class="admin-teams">{row.teams}</span>
                  <span class="admin-meta">{row.result}</span>
                  <div class="admin-actions">
                    <button type="button" class="secondary" disabled={busy === game.code} onClick={() => toggleTest(game)}>
                      {testToggleLabel(game)}
                    </button>
                    <button type="button" class="danger" disabled={busy === game.code} onClick={() => setConfirmDelete(game)}>
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section class="stack" aria-labelledby="catalog-title">
        <h2 id="catalog-title">Catalog</h2>
        <p class="quiet-note">Read-only. Edit catalog/catalog.json in the repo to change it.</p>
        {catalog?.categories.map((cat) => (
          <div class={`catalog-cat${cat.active ? "" : " inactive"}`} key={cat.id}>
            <h3>{cat.name}</h3>
            <p class="admin-meta">{catalogSummary(cat)}</p>
            <ul>
              {cat.tasks.map((task) => (
                <li key={task.id} class={task.active ? undefined : "inactive"}>
                  {task.text}
                  {!task.active && <span class="admin-meta"> (inactive)</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <button type="button" class="secondary" onClick={onLogout}>
        Log out
      </button>

      {confirmDelete && dialog && (
        <ConfirmDialog
          title={dialog.title}
          body={dialog.body}
          confirmLabel="Delete"
          danger
          onConfirm={() => remove(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </>
  );
}
