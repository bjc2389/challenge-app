import { useState } from "preact/hooks";
import { ApiError, apiFetch } from "../api";

type Props = { endpoint: string; onSuccess(): void };

const MSG_BAD_LOGIN = "Wrong password";
const MSG_FAILED = "Something went wrong";

// One password field and a submit button. A wrong password takes about a second
// to come back, so the button stays disabled until it does.
export function PasswordForm({ endpoint, onSuccess }: Props) {
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: Event) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await apiFetch(endpoint, { method: "POST", body: JSON.stringify({ password }) }, { redirectOn401: false });
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? MSG_BAD_LOGIN : MSG_FAILED);
      setPending(false);
    }
  };

  return (
    <form class="stack" onSubmit={submit}>
      <label for="password">Password</label>
      <input
        id="password"
        type="password"
        autocomplete="current-password"
        required
        autofocus
        value={password}
        onInput={(e) => setPassword(e.currentTarget.value)}
      />
      <button type="submit" disabled={pending}>
        {pending ? "Checking…" : "Log in"}
      </button>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
