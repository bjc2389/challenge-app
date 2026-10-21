import { useEffect, useRef, useState } from "preact/hooks";

// Shares the game link with the phone's share sheet, or copies it. If both fail,
// shows the link selected so it can be copied by hand.
export function ShareButton({ code }: { code: string }) {
  const [status, setStatus] = useState<string | null>(null);
  const [fallback, setFallback] = useState(false);
  const urlInput = useRef<HTMLInputElement>(null);
  // Select once when shown, not on every re-render (each poll re-renders).
  useEffect(() => {
    if (fallback) urlInput.current?.select();
  }, [fallback]);
  const url = `${location.origin}/g/${code}`;

  const share = async () => {
    setStatus(null);
    if (navigator.share) {
      try {
        await navigator.share({ title: "Challenge", text: `Join game ${code}`, url });
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setStatus("Link copied");
    } catch {
      setFallback(true);
    }
  };

  return (
    <div class="share">
      <button type="button" class="secondary" onClick={share}>
        Share game
      </button>
      <span class="visually-hidden" aria-live="polite">
        {status}
      </span>
      {status && <span aria-hidden="true">{status}</span>}
      {fallback && (
        <input
          class="share-url"
          readOnly
          value={url}
          aria-label="Game link"
          ref={urlInput}
        />
      )}
    </div>
  );
}
