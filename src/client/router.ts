import { useEffect, useState } from "preact/hooks";

// A minimal client router: the current path, and navigation via the History API.
export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onChange = () => setPath(location.pathname);
    addEventListener("popstate", onChange);
    return () => removeEventListener("popstate", onChange);
  }, []);
  return path;
}

export function navigate(to: string, { replace = false }: { replace?: boolean } = {}) {
  if (replace) history.replaceState(null, "", to);
  else {
    history.pushState(null, "", to);
    scrollTo(0, 0);
  }
  dispatchEvent(new PopStateEvent("popstate"));
}
