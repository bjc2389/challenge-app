import { Component, type ComponentChildren } from "preact";
import { Link } from "./Link";

type Props = { path: string; children: ComponentChildren };
type State = { failed: boolean; path: string };

// SPEC.md §9: an unexpected render error shows a way out, never a blank screen.
// It clears when the path changes, so navigating away recovers without a reload.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, path: this.props.path };

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.path === state.path ? null : { failed: false, path: props.path };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
    this.setState({ failed: true });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main class="stack">
        <h1>Something went wrong</h1>
        <button type="button" onClick={() => location.reload()}>
          Reload
        </button>
        <Link href="/">Home</Link>
      </main>
    );
  }
}
