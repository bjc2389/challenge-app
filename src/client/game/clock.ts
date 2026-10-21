// The countdown, corrected for each phone's clock using serverNow (SPEC.md §6).

/** offsetMs: add to the local clock to get server time. rttMs: how long the request took. */
export type ClockSample = { offsetMs: number; rttMs: number };

/** Assumes the server read its clock halfway through the request. */
export function sampleOffset(serverNow: number, sentAt: number, receivedAt: number): ClockSample {
  return { offsetMs: serverNow - (sentAt + receivedAt) / 2, rttMs: receivedAt - sentAt };
}

/** The faster request gives the tighter estimate, so a slow response can't make the timer jump. */
export function betterSample(current: ClockSample | null, next: ClockSample): ClockSample {
  return current !== null && current.rttMs < next.rttMs ? current : next;
}

export function remainingMs(endsAt: number | null, offsetMs: number, now: number): number | null {
  return endsAt === null ? null : endsAt - (now + offsetMs);
}

/** "60:00" … "0:01", then "Time!". Rounds up, so "0:00" never shows. */
export function formatClock(ms: number): string {
  if (ms <= 0) return "Time!";
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export const isTimeUp = (ms: number | null) => ms !== null && ms <= 0;
