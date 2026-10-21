import { useEffect, useState } from "preact/hooks";
import { ApiError, apiFetch } from "../api";
import { Link } from "../components/Link";
import { errorMessage } from "../game/errors";
import { endReasonText, formatDate, formatElapsed, resultText } from "../history/format";
import type { HistoryDetail } from "../history/types";
import { eventRows, splitRows } from "../history/view";

// SPEC.md §9: one game's result, length, split times and full event log.
export function HistoryGame({ code }: { code: string | null }) {
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [missing, setMissing] = useState(code === null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    document.title = `Game ${code} · Challenge`;
    apiFetch<HistoryDetail>(`/api/history/${code}`)
      .then(setDetail)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) setMissing(true);
        else setError(errorMessage(err));
      });
    return () => {
      document.title = "Challenge";
    };
  }, [code]);

  const links = (
    <p class="row">
      <Link href="/history">All games</Link>
      <Link href="/">Home</Link>
    </p>
  );

  if (missing) {
    return (
      <main class="stack">
        <h1>No finished game with that code</h1>
        <p>Games appear here once they're finished or abandoned.</p>
        {links}
      </main>
    );
  }
  if (!detail) {
    return (
      <main class="stack">
        {error ? (
          <p class="error" role="alert">
            {error}
          </p>
        ) : (
          <p aria-live="polite">Loading…</p>
        )}
        {links}
      </main>
    );
  }

  const { game, teams } = detail;
  const [one, two] = [...teams].sort((a, b) => a.slot - b.slot);
  const splits = splitRows(detail);
  const events = eventRows(detail);

  return (
    <main class="stack">
      <section class="result" aria-labelledby="result-title">
        <h1 id="result-title">{resultText({ ...game, teams })}</h1>
        <p>
          {endReasonText(game)} · {formatElapsed(game.elapsedMs)}
          {game.endedAt !== null && <> · {formatDate(game.endedAt)}</>}
        </p>
      </section>

      <p class="game-code">
        Game <strong>{game.code}</strong>
      </p>

      <dl class="team-summary">
        {[one, two].map(
          (team) =>
            team && (
              <div key={team.id}>
                <dt>{team.name}</dt>
                <dd>
                  {team.score} task{team.score === 1 ? "" : "s"}
                  {team.puzzleMs !== null && <> · puzzle in {formatElapsed(team.puzzleMs)}</>}
                </dd>
              </div>
            ),
        )}
      </dl>

      {splits.length > 0 && (
        <section class="stack" aria-labelledby="splits-title">
          <h2 id="splits-title">Split times</h2>
          <table class="splits">
            <caption class="visually-hidden">Time from the start when each team finished each task</caption>
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">{one?.name}</th>
                <th scope="col">{two?.name}</th>
              </tr>
            </thead>
            <tbody>
              {splits.map((row, i) => (
                <tr key={i}>
                  <th scope="row">{row.task}</th>
                  <td>{row.times[0]}</td>
                  <td>{row.times[1]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p class="quiet-note">Minutes:seconds from the start. "—" means not done.</p>
        </section>
      )}

      {events.length > 0 && (
        <section class="stack" aria-labelledby="events-title">
          <h2 id="events-title">Event log</h2>
          <ol class="event-log">
            {events.map((row, i) => (
              <li key={i}>
                <span class="event-time">{row.time}</span> {row.text}
              </li>
            ))}
          </ol>
        </section>
      )}
      {links}
    </main>
  );
}
