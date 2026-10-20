import { useEffect, useState } from "preact/hooks";
import { apiFetch } from "../api";
import { PasswordForm } from "../components/PasswordForm";
import { navigate } from "../router";

type SessionInfo = { role: "player" | "admin"; exp: number };

// M1 scope: admin login and logout only. The games table and catalog view come in M6.
export function Admin() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    apiFetch<SessionInfo>("/api/session", undefined, { redirectOn401: false })
      .then((s) => setIsAdmin(s.role === "admin"))
      .catch(() => setIsAdmin(false));
  }, []);

  const logout = async () => {
    await apiFetch("/api/logout", { method: "POST" }, { redirectOn401: false }).catch(() => {});
    navigate("/login");
  };

  return (
    <main>
      <h1>Admin</h1>
      {isAdmin === null ? null : isAdmin ? (
        <div class="stack">
          <p>Signed in as admin.</p>
          <button type="button" onClick={logout}>
            Log out
          </button>
        </div>
      ) : (
        <PasswordForm endpoint="/api/admin/login" onSuccess={() => setIsAdmin(true)} />
      )}
    </main>
  );
}
