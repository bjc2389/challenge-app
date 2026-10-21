import { Link } from "../components/Link";

export function NotFound() {
  return (
    <main class="stack">
      <h1>Not found</h1>
      <p>There's nothing at this address.</p>
      <Link href="/">Home</Link>
    </main>
  );
}
