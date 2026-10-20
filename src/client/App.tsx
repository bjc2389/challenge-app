import { Admin } from "./pages/Admin";
import { Home } from "./pages/Home";
import { Login } from "./pages/Login";
import { usePath } from "./router";

export function App() {
  switch (usePath()) {
    case "/login":
      return <Login />;
    case "/admin":
      return <Admin />;
    default:
      return <Home />;
  }
}
