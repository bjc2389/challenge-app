import { Admin } from "./pages/Admin";
import { Game } from "./pages/Game";
import { History } from "./pages/History";
import { Home } from "./pages/Home";
import { Login } from "./pages/Login";
import { NotFound } from "./pages/NotFound";
import { matchRoute } from "./routes";
import { usePath } from "./router";

export function App() {
  const route = matchRoute(usePath());
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
    case "historyGame":
      return <History />;
    case "notFound":
      return <NotFound />;
  }
}
