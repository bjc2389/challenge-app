import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiError, apiFetch } from "../../api";
import { betterSample, sampleOffset, type ClockSample } from "../../game/clock";
import { errorMessage } from "../../game/errors";
import { createPoller, type Poller } from "../../game/poll";
import type { GameStatus, GameView } from "../../game/types";
import { pickNewer, shouldReveal } from "../../game/view";

/** GET or write with timing, so every response can correct the clock. */
async function timed(path: string, init?: RequestInit) {
  const sentAt = Date.now();
  const view = await apiFetch<GameView>(path, init);
  return { view, sentAt, receivedAt: Date.now() };
}

export type GameState = ReturnType<typeof useGame>;

// Everything the game page needs: the latest view, the clock offset, polling with
// visibility pause (SPEC.md §6), and writes that show a pending state per cell.
export function useGame(code: string) {
  const [view, setView] = useState<GameView | null>(null);
  const [missing, setMissing] = useState(false);
  const [sample, setSample] = useState<ClockSample | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [reveal, setReveal] = useState(false);
  const poller = useRef<Poller | null>(null);
  const status = useRef<GameStatus | null>(null);

  const apply = useCallback((next: GameView) => {
    setView((current) => {
      const chosen = pickNewer(current, next);
      if (shouldReveal(status.current, chosen.game.status)) setReveal(true);
      status.current = chosen.game.status;
      return chosen;
    });
  }, []);

  const addSample = useCallback((s: ClockSample) => setSample((current) => betterSample(current, s)), []);

  useEffect(() => {
    let cancelled = false;
    const p = createPoller({
      fetchView: (signal) => timed(`/api/games/${code}`, { signal }),
      schedule: (fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      onView: apply,
      onSample: (s) => {
        addSample(s);
        setReconnecting(false);
      },
      onError: (_err, failures) => setReconnecting(failures >= 2),
      onStop: (reason) => {
        if (reason === "notFound") setMissing(true);
      },
    });
    poller.current = p;

    const onVisibility = () => p.setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);

    timed(`/api/games/${code}`)
      .then(({ view: first, sentAt, receivedAt }) => {
        if (cancelled) return;
        apply(first);
        addSample(sampleOffset(first.serverNow, sentAt, receivedAt));
        onVisibility();
        p.start(first);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setMissing(true);
        else if (!(err instanceof ApiError && err.status === 401)) {
          setToast(errorMessage(err));
          onVisibility();
          p.start();
        }
      });

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      p.stop();
    };
  }, [code, apply, addSample]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  /** Sends a write. `key` marks what's pending (a cell, or a button). Returns success. */
  const act = useCallback(
    async (key: string, method: string, path: string, body?: unknown): Promise<boolean> => {
      setPending((s) => new Set(s).add(key));
      try {
        const res = await timed(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
        apply(res.view);
        addSample(sampleOffset(res.view.serverNow, res.sentAt, res.receivedAt));
        poller.current?.accept(res.view);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return false;
        setToast(errorMessage(err));
        poller.current?.kick();
        return false;
      } finally {
        setPending((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        });
      }
    },
    [apply, addSample],
  );

  const refresh = useCallback(() => poller.current?.kick(), []);

  return { view, missing, offsetMs: sample?.offsetMs ?? 0, pending, toast, reconnecting, reveal, act, refresh };
}
