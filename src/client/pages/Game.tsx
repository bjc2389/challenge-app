import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Link } from "../components/Link";
import { ShareButton } from "../components/ShareButton";
import { isOver, type GameView } from "../game/types";
import { resultBanner, teamBySlot } from "../game/view";
import { rememberGame } from "../lastGame";
import { navigate } from "../router";
import { Board, cellKey, type CellAction } from "./game/Board";
import { Countdown } from "./game/Countdown";
import { Scoreboard } from "./game/Scoreboard";
import { TeamNamesForm, type Names } from "./game/TeamNamesForm";
import { useGame, type GameState } from "./game/useGame";

type Confirm = { kind: "undo"; cell: CellAction; teamName: string } | { kind: "abandon" };

export function Game({ code, canonical }: { code: string | null; canonical: boolean }) {
  useEffect(() => {
    if (code && !canonical) navigate(`/g/${code}`, { replace: true });
  }, [code, canonical]);

  if (!code) return <Missing />;
  return <LoadedGame code={code} />;
}

function Missing() {
  return (
    <main class="stack">
      <h1>No game with that code</h1>
      <p>Check the code and try again.</p>
      <Link href="/">Home</Link>
    </main>
  );
}

function LoadedGame({ code }: { code: string }) {
  const game = useGame(code);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  useEffect(() => {
    document.title = `Game ${code} · Challenge`;
    rememberGame(code);
    return () => {
      document.title = "Challenge";
    };
  }, [code]);

  const status = game.view?.game.status;
  useWakeLock(status === "active");

  // A dialog never outlives its stage: undo only applies while active, and
  // nothing applies once the game is over.
  useEffect(() => {
    if (status !== "active") setConfirm((c) => (c?.kind === "undo" ? null : c));
    if (game.view && isOver(game.view)) setConfirm(null);
  }, [status, game.view]);

  if (game.missing) return <Missing />;
  if (!game.view) {
    return (
      <main>
        <p aria-live="polite">Loading game…</p>
      </main>
    );
  }
  const view = game.view;

  const base = `/api/games/${view.game.code}`;
  const abandon = () => setConfirm({ kind: "abandon" });
  const onConfirm = async () => {
    const current = confirm;
    setConfirm(null);
    if (current?.kind === "abandon") await game.act("abandon", "POST", `${base}/abandon`);
    if (current?.kind === "undo") {
      const { task, slotIndex } = current.cell;
      await game.act(cellKey(task.id, slotIndex), "POST", `${base}/tasks/${task.id}/undo`, {
        teamId: teamBySlot(view, slotIndex === 0 ? 1 : 2).id,
      });
    }
  };

  return (
    <>
      {view.game.status === "setup" && <SetupView view={view} game={game} onAbandon={abandon} />}
      {view.game.status === "rolled" && <RolledView view={view} game={game} onAbandon={abandon} />}
      {view.game.status === "active" && (
        <ActiveView view={view} game={game} onAbandon={abandon} onUndo={(cell, teamName) => setConfirm({ kind: "undo", cell, teamName })} />
      )}
      {(view.game.status === "finished" || view.game.status === "abandoned") && <OverView view={view} />}

      {game.reconnecting && (
        <p class="reconnecting" role="status">
          Reconnecting…
        </p>
      )}
      {game.toast && (
        <p class="toast" role="alert">
          {game.toast}
        </p>
      )}
      {confirm?.kind === "undo" && (
        <ConfirmDialog
          title={`Undo “${confirm.cell.task.text}” for ${confirm.teamName}?`}
          confirmLabel="Undo"
          cancelLabel="Keep"
          onConfirm={onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === "abandon" && (
        <ConfirmDialog
          title="Abandon this game?"
          body="It can't be resumed and won't count in records."
          confirmLabel="Abandon"
          danger
          onConfirm={onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}

type ViewProps = { view: GameView; game: GameState; onAbandon(): void };

function GameHeader({ view }: { view: GameView }) {
  return (
    <div class="game-header">
      <p class="game-code">
        Game <strong>{view.game.code}</strong>
      </p>
      <ShareButton code={view.game.code} />
    </div>
  );
}

function AbandonButton({ onAbandon, busy }: { onAbandon(): void; busy: boolean }) {
  return (
    <button type="button" class="secondary abandon" onClick={onAbandon} disabled={busy}>
      Abandon game
    </button>
  );
}

function useSaveNames(view: GameView, game: GameState) {
  return useCallback(
    (names: Names) => game.act("names", "PATCH", `/api/games/${view.game.code}/teams`, names),
    [game, view.game.code],
  );
}

function SetupView({ view, game, onAbandon }: ViewProps) {
  const saveNames = useSaveNames(view, game);
  const saving = game.pending.has("names");
  const rolling = game.pending.has("roll");
  const busy = saving || rolling;
  return (
    <main class="stack">
      <h1>New game</h1>
      <GameHeader view={view} />
      <p>Name the two teams, then roll for this game's tasks.</p>
      <TeamNamesForm
        view={view}
        submitLabel={saving ? "Saving names…" : rolling ? "Rolling…" : "Roll the dice"}
        busy={busy}
        alwaysSubmit
        onSubmit={async (names, changed) => {
          if (changed && !(await saveNames(names))) return false;
          return game.act("roll", "POST", `/api/games/${view.game.code}/roll`);
        }}
      />
      <AbandonButton onAbandon={onAbandon} busy={game.pending.has("abandon")} />
    </main>
  );
}

function RolledView({ view, game, onAbandon }: ViewProps) {
  const saveNames = useSaveNames(view, game);
  return (
    <main class="stack">
      <h1>Get ready</h1>
      <GameHeader view={view} />
      <p>Gather supplies for these tasks. The clock starts when you press Start.</p>
      <Board view={view} timeUp={false} pending={game.pending} reveal={game.reveal} />
      <TeamNamesForm
        view={view}
        submitLabel="Save names"
        busy={game.pending.has("names")}
        onSubmit={(names, changed) => (changed ? saveNames(names) : Promise.resolve(true))}
      />
      <button
        type="button"
        class="start"
        disabled={game.pending.has("start")}
        onClick={() => game.act("start", "POST", `/api/games/${view.game.code}/start`)}
      >
        Start
      </button>
      <AbandonButton onAbandon={onAbandon} busy={game.pending.has("abandon")} />
    </main>
  );
}

function ActiveView({ view, game, onAbandon, onUndo }: ViewProps & { onUndo(cell: CellAction, teamName: string): void }) {
  const [timeUp, setTimeUp] = useState(false);
  const refresh = game.refresh;
  const onTimeUp = useCallback(
    (up: boolean) => {
      setTimeUp(up);
      // Ask the server for the result now rather than at the next poll.
      if (up) refresh();
    },
    [refresh],
  );

  const onCell = (cell: CellAction) => {
    const team = teamBySlot(view, cell.slotIndex === 0 ? 1 : 2);
    if (cell.action === "undo") return onUndo(cell, team.name);
    void game.act(cellKey(cell.task.id, cell.slotIndex), "POST", `/api/games/${view.game.code}/tasks/${cell.task.id}/complete`, {
      teamId: team.id,
    });
  };

  return (
    <main class="stack game-active">
      <div class="sticky-header">
        <Countdown endsAt={view.game.endsAt} durationMs={view.game.durationMs} offsetMs={game.offsetMs} onTimeUp={onTimeUp} />
        <Scoreboard view={view} />
      </div>
      <Board view={view} timeUp={timeUp} pending={game.pending} reveal={false} onCell={onCell} />
      <GameHeader view={view} />
      <AbandonButton onAbandon={onAbandon} busy={game.pending.has("abandon")} />
    </main>
  );
}

function OverView({ view }: { view: GameView }) {
  const banner = resultBanner(view);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <main class="stack">
      <section class="result" role="status">
        <h1 ref={heading} tabIndex={-1}>
          {banner?.title}
        </h1>
        <p>{banner?.detail}</p>
      </section>
      <Scoreboard view={view} />
      <Board view={view} timeUp={true} pending={new Set()} reveal={false} />
      <Link href={`/history/${view.game.code}`}>Game details</Link>
      <Link href="/">Home</Link>
    </main>
  );
}

/** Keeps the screen on during an active game, where the browser supports it. */
function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let released = false;
    const acquire = async () => {
      // Skip if hidden, or if a lock is already held (two calls can race).
      if (document.visibilityState !== "visible" || (lock && !lock.released)) return;
      try {
        lock = await navigator.wakeLock.request("screen");
        if (released) await lock.release();
      } catch {
        // Denied (battery saver, unsupported context): the game works without it.
      }
    };
    void acquire();
    // The lock drops when the page is hidden; take it again on return.
    document.addEventListener("visibilitychange", acquire);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release().catch(() => {});
    };
  }, [active]);
}
