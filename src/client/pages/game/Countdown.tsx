import { useEffect, useRef, useState } from "preact/hooks";
import { formatClock, isTimeUp, remainingMs } from "../../game/clock";

type Props = {
  endsAt: number | null;
  durationMs: number;
  offsetMs: number;
  /** Called once when the countdown reaches zero, and with false if it's reset. */
  onTimeUp(timeUp: boolean): void;
};

const ANNOUNCE_AT_MINUTES = [10, 5, 1];

// Counts down to ends_at on the server's clock (SPEC.md §6). At zero it shows
// "Time!" and leaves the result to the server.
export function Countdown({ endsAt, durationMs, offsetMs, onTimeUp }: Props) {
  const compute = () => remainingMs(endsAt, offsetMs, Date.now());
  const [text, setText] = useState(() => formatClock(compute() ?? durationMs));
  const [announcement, setAnnouncement] = useState("");
  const wasUp = useRef<boolean | null>(null);
  const lastMinute = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => {
      const ms = compute();
      setText(formatClock(ms ?? durationMs));
      const up = isTimeUp(ms);
      if (up !== wasUp.current) {
        wasUp.current = up;
        onTimeUp(up);
        if (up) setAnnouncement("Time!");
      }
      if (ms !== null && ms > 0) {
        const minute = Math.ceil(ms / 60_000);
        if (lastMinute.current !== null && minute < lastMinute.current && ANNOUNCE_AT_MINUTES.includes(minute)) {
          setAnnouncement(`${minute} minute${minute === 1 ? "" : "s"} left`);
        }
        lastMinute.current = minute;
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [endsAt, offsetMs, durationMs, onTimeUp]);

  return (
    <>
      <div class="timer" role="timer" aria-live="off" aria-label="Time left">
        {text}
      </div>
      <span class="visually-hidden" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}
