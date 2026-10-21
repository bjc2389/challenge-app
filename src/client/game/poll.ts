// Polls GET /api/games/:code (SPEC.md §6): every 3 s after the last response while
// the page is visible, never two requests at once, backing off on errors, and
// stopping once the game is over. Timers and fetch are injected for tests.
import { ApiError } from "../apiError";
import { sampleOffset, type ClockSample } from "./clock";
import { isOver, type GameView } from "./types";

export type StopReason = "terminal" | "notFound" | "unauthorized" | "stopped";

export type PollerDeps = {
  fetchView(signal: AbortSignal): Promise<{ view: GameView; sentAt: number; receivedAt: number }>;
  /** Runs `fn` after `ms`; returns a cancel function. */
  schedule(fn: () => void, ms: number): () => void;
  intervalMs?: number;
  maxBackoffMs?: number;
  /** A view with a higher version than any seen so far. */
  onView(view: GameView): void;
  /** Every response, for clock correction. */
  onSample(sample: ClockSample): void;
  onError(err: unknown, failures: number): void;
  onStop(reason: StopReason): void;
};

export type Poller = ReturnType<typeof createPoller>;

export function createPoller(deps: PollerDeps) {
  const intervalMs = deps.intervalMs ?? 3000;
  const maxBackoffMs = deps.maxBackoffMs ?? 30_000;

  let running = false;
  let visible = true;
  let lastVersion = -Infinity;
  let failures = 0;
  let followUp = false;
  let cancelTimer: (() => void) | null = null;
  let inFlight: AbortController | null = null;

  const clearTimer = () => {
    cancelTimer?.();
    cancelTimer = null;
  };

  const end = (reason: StopReason) => {
    if (!running) return;
    running = false;
    clearTimer();
    inFlight?.abort();
    inFlight = null;
    deps.onStop(reason);
  };

  const scheduleIn = (ms: number) => {
    clearTimer();
    if (running && visible) cancelTimer = deps.schedule(poll, ms);
  };

  /** After a response: a pending kick polls now, otherwise wait `ms`. */
  const next = (ms: number) => {
    if (followUp && visible) {
      followUp = false;
      poll();
    } else {
      followUp = false;
      scheduleIn(ms);
    }
  };

  function poll() {
    cancelTimer = null;
    if (!running || inFlight) return;
    const request = new AbortController();
    inFlight = request;
    deps.fetchView(request.signal).then(
      ({ view, sentAt, receivedAt }) => {
        if (inFlight !== request) return; // stopped or superseded
        inFlight = null;
        failures = 0;
        deps.onSample(sampleOffset(view.serverNow, sentAt, receivedAt));
        if (view.version > lastVersion) {
          lastVersion = view.version;
          deps.onView(view);
        }
        if (isOver(view)) return end("terminal");
        next(intervalMs);
      },
      (err: unknown) => {
        if (inFlight !== request) return;
        inFlight = null;
        if (err instanceof ApiError && err.status === 404) return end("notFound");
        if (err instanceof ApiError && err.status === 401) return end("unauthorized");
        failures += 1;
        deps.onError(err, failures);
        next(Math.min(intervalMs * 2 ** (failures - 1), maxBackoffMs));
      },
    );
  }

  return {
    get running() {
      return running;
    },
    start(initial?: GameView) {
      running = true;
      if (initial) {
        lastVersion = initial.version;
        if (isOver(initial)) return end("terminal");
      }
      scheduleIn(intervalMs);
    },
    stop() {
      end("stopped");
    },
    setVisible(nowVisible: boolean) {
      const wasVisible = visible;
      visible = nowVisible;
      if (!visible) clearTimer();
      else if (!wasVisible && running && !inFlight) poll();
    },
    /** Poll now (or right after the request in flight). */
    kick() {
      if (!running) return;
      if (inFlight) followUp = true;
      else {
        clearTimer();
        poll();
      }
    },
    /** A view from a write response: the caller already shows it. */
    accept(view: GameView) {
      if (view.version > lastVersion) lastVersion = view.version;
      if (isOver(view)) return end("terminal");
      if (!inFlight) scheduleIn(intervalMs);
    },
  };
}
