import { ErrorBoundary } from "./components/ErrorBoundary";
import { Admin } from "./pages/Admin";
import { Game } from "./pages/Game";
import { History } from "./pages/History";
import { HistoryGame } from "./pages/HistoryGame";
import { Home } from "./pages/Home";
import { Login } from "./pages/Login";
import { NotFound } from "./pages/NotFound";
import { matchRoute } from "./routes";
import { usePath } from "./router";

export function App() {
  const path = usePath();
  return (
    <ErrorBoundary path={path}>
      <Page path={path} />
    </ErrorBoundary>
  );
}

function Page({ path }: { path: string }) {
  const route = matchRoute(path);
  switch (route.name) {
    case "home":
      return <Home />;
    case "login":
      return <Login />;
    case "admin":
      return <Admin />;
    case "game":
      return <Game key={route.code ?? "none"} code={route.code} canonical={route.canonical} />;
    case "history":
      return <History />;
    case "historyGame":
      return <HistoryGame key={route.code ?? "none"} code={route.code} />;
    case "notFound":
      return <NotFound />;
  }
}
