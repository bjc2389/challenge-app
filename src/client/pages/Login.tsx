import { PasswordForm } from "../components/PasswordForm";
import { safeNextPath } from "../nav";
import { navigate } from "../router";

export function Login() {
  const next = safeNextPath(new URLSearchParams(location.search).get("next"));
  return (
    <main>
      <h1>Challenge</h1>
      <PasswordForm endpoint="/api/login" onSuccess={() => navigate(next, { replace: true })} />
    </main>
  );
}
