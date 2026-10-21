import { useEffect, useState } from "preact/hooks";
import { apiFetch } from "../api";
import { Link } from "../components/Link";
import { errorMessage } from "../game/errors";
import { endReasonText, formatDate, formatElapsed, resultText } from "../history/format";
import type { HistoryList } from "../history/types";
import { recordRows, scoreLine } from "../history/view";

// SPEC.md §9: records, then finished and abandoned games, newest first.
export function History() {
  const [list, setList] = useState<HistoryList | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "History · Challenge";
    apiFetch<HistoryList>("/api/history")
      .then(setList)
      .catch((err) => setError(errorMessage(err)));
    return () => {
      document.title = "Challenge";
    };
  }, []);

  return (
    <main class="stack">
      <h1>History</h1>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {!list && !error && <p aria-live="polite">Loading…</p>}
      {list && (
        <>
          <section class="records" aria-labelledby="records-title">
            <h2 id="records-title">Records</h2>
            <dl>
              {recordRows(list.records).map((row) => (
                <div class="record" key={row.label}>
                  <dt>{row.label}</dt>
                  <dd class="record-value">{row.value}</dd>
                  <dd class="record-holder">{row.holder}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section class="stack" aria-labelledby="games-title">
            <h2 id="games-title">Games</h2>
            {list.items.length === 0 ? (
              <p>No finished games yet.</p>
            ) : (
              <ul class="history-list">
                {list.items.map((item) => (
                  <li key={item.code}>
                    <Link href={`/history/${item.code}`} class="history-item">
                      <span class="history-top">
                        <span>{item.endedAt === null ? "" : formatDate(item.endedAt)}</span>
                        {item.status === "abandoned" && <span class="tag-abandoned">Abandoned</span>}
                      </span>
                      <span class="history-score">{scoreLine(item)}</span>
                      <span class="history-meta">
                        {item.status === "abandoned"
                          ? endReasonText(item)
                          : `${resultText(item)} · ${endReasonText(item)}`}{" "}
                        · {formatElapsed(item.elapsedMs)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {list.hasMore && <p class="quiet-note">Showing the latest {list.items.length} games.</p>}
          </section>
        </>
      )}
      <Link href="/">Home</Link>
    </main>
  );
}
