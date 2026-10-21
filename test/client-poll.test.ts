// SPEC.md §6 live updates: poll GET /api/games/:code every 3 s while visible, pause when
// hidden, stop when the game is over; serverNow corrects drift; version lets the client
// skip redraws. §10: 401 (not logged in) and 404 (no such game) end polling.
// Time is a hand-rolled fake scheduler; fetchView is a deferred promise per call.
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/client/apiError";
import { sampleOffset } from "../src/client/game/clock";
import { createPoller } from "../src/client/game/poll";
import type { GameView } from "../src/client/game/types";
import { makeView } from "./helpers/view-fixture";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Deferred<T> = { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets pending promise callbacks run. Uses a real macrotask only to yield, never for timing. */
async function flush() {
  for (let i = 0; i < 3; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

type Timer = { fn: () => void; at: number; ms: number; cancelled: boolean; fired: boolean };

function fakeScheduler() {
  let now = 0;
  const timers: Timer[] = [];
  return {
    now: () => now,
    schedule(fn: () => void, ms: number): () => void {
      const t: Timer = { fn, at: now + ms, ms, cancelled: false, fired: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    /** Live (not cancelled, not fired) timers. */
    live: () => timers.filter((t) => !t.cancelled && !t.fired),
    /** Delays of every schedule() call, in order. */
    scheduledMs: () => timers.map((t) => t.ms),
    /** Moves time forward, running due callbacks in time order, then flushes promises. */
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = timers.filter((t) => !t.cancelled && !t.fired && t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        due.fired = true;
        due.fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

type FetchResult = { view: GameView; sentAt: number; receivedAt: number };

function setup(opts: { intervalMs?: number; maxBackoffMs?: number } = {}) {
  const sched = fakeScheduler();
  const calls: { signal: AbortSignal; d: Deferred<FetchResult> }[] = [];
  const log: string[] = [];
  const onView = vi.fn((v: GameView) => void log.push(`view:${v.version}`));
  const onSample = vi.fn(() => void log.push("sample"));
  const onError = vi.fn((_e: unknown, n: number) => void log.push(`error:${n}`));
  const onStop = vi.fn((reason: string) => void log.push(`stop:${reason}`));
  const poller = createPoller({
    fetchView: (signal: AbortSignal) => {
      const d = deferred<FetchResult>();
      calls.push({ signal, d });
      return d.promise;
    },
    schedule: sched.schedule,
    ...opts,
    onView,
    onSample,
    onError,
    onStop,
  });

  const last = () => {
    const c = calls[calls.length - 1];
    if (!c) throw new Error("no fetch yet");
    return c;
  };

  return {
    sched,
    calls,
    log,
    poller,
    onView,
    onSample,
    onError,
    onStop,
    fetches: () => calls.length,
    /** Resolves the latest request. Default sentAt/receivedAt bracket the current fake time. */
    async respond(view: GameView, t: { sentAt?: number; receivedAt?: number } = {}) {
      last().d.resolve({ view, sentAt: t.sentAt ?? sched.now() - 100, receivedAt: t.receivedAt ?? sched.now() });
      await flush();
    },
    async fail(err: unknown) {
      last().d.reject(err);
      await flush();
    },
  };
}

const v = (version: number, status: GameView["game"]["status"] = "active") => makeView({ version, status });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("§6 poller: start", () => {
  it("is not running before start, and running after", () => {
    const h = setup();
    expect(h.poller.running).toBe(false);
    h.poller.start(v(5));
    expect(h.poller.running).toBe(true);
  });

  it("does not fetch at once; schedules the first poll 3 s out", async () => {
    const h = setup();
    h.poller.start(v(5));
    await flush();
    expect(h.fetches()).toBe(0);
    await h.sched.advance(2_999);
    expect(h.fetches()).toBe(0);
    await h.sched.advance(1);
    expect(h.fetches()).toBe(1);
  });

  it("honours a custom intervalMs", async () => {
    const h = setup({ intervalMs: 1_000 });
    h.poller.start(v(5));
    await h.sched.advance(999);
    expect(h.fetches()).toBe(0);
    await h.sched.advance(1);
    expect(h.fetches()).toBe(1);
  });

  it.each(["finished", "abandoned"] as const)("a %s initial view stops with terminal and never fetches", async (status) => {
    const h = setup();
    h.poller.start(v(5, status));
    await h.sched.advance(60_000);
    expect(h.fetches()).toBe(0);
    expect(h.onStop).toHaveBeenCalledTimes(1);
    expect(h.onStop).toHaveBeenCalledWith("terminal");
    expect(h.poller.running).toBe(false);
  });

  it("start() without an initial view still polls and reports the first view", async () => {
    const h = setup();
    h.poller.start();
    await h.sched.advance(3_000);
    expect(h.fetches()).toBe(1);
    await h.respond(v(1));
    expect(h.onView).toHaveBeenCalledTimes(1);
  });
});

describe("§6 poller: 3 s cadence after each response", () => {
  it("schedules the next poll intervalMs after the response, not after the request", async () => {
    const h = setup();
    h.poller.start(v(5));
    await h.sched.advance(3_000); // t=3000 request 1
    await h.sched.advance(2_000); // t=5000 slow response
    await h.respond(v(5));
    await h.sched.advance(2_999); // t=7999
    expect(h.fetches()).toBe(1);
    await h.sched.advance(1); // t=8000
    expect(h.fetches()).toBe(2);
  });

  it("keeps polling every 3 s while nothing changes", async () => {
    const h = setup();
    h.poller.start(v(5));
    for (let i = 1; i <= 5; i++) {
      await h.sched.advance(3_000);
      expect(h.fetches()).toBe(i);
      await h.respond(v(5));
    }
  });

  it("a slow response doesn't stack requests", async () => {
    const h = setup();
    h.poller.start(v(5));
    await h.sched.advance(3_000);
    expect(h.fetches()).toBe(1);
    await h.sched.advance(60_000);
    expect(h.fetches()).toBe(1);
    expect(h.sched.live()).toHaveLength(0);
  });

  it("passes a live (not aborted) signal to fetchView", async () => {
    const h = setup();
    h.poller.start(v(5));
    await h.sched.advance(3_000);
    expect(h.calls[0]?.signal.aborted).toBe(false);
  });
});

describe("§6 poller: version and serverNow", () => {
  it("a higher version calls onView", async () => {
    const h = setup();
    h.poller.start(v(5));
    await h.sched.advance(3_000);
    const next = v(6);
    await h.respond(next);
    expect(h.onView).toHaveBeenCalledTimes(1);
    expect(h.onView).toHaveBeenCalledWith(next);
  });

  it.each([5, 4])("version %d (not above 5) is skipped, but onSample is still called", async (version) => {
    const h = setup();
    h.poller.start(v(5));
    await h.sched.advance(3_000);
    await h.respond(v(version));
    expect(h.onView).not.toHaveBeenCalled();
    expect(h.onSample).toHaveBeenCalledTimes(1);
  });

  it("onSample gets sampleOffset(serverNow, sentAt, receivedAt)", async () => {
    const h = setup();
    h.poller.start(v(5));
    await h.sched.advance(3_000);
    const view = makeView({ version: 6, serverNow: 1_000_000 });
    await h.respond(view, { sentAt: 2_800, receivedAt: 3_000 });
    expect(h.onSample).toHaveBeenCalledWith(sampleOffset(1_000_000, 2_800, 3_000));
    expect(h.onSample).toHaveBeenCalledWith({ offsetMs: 1_000_000 - 2_900, rttMs: 200 });
  });

  it("lastVersion advances: the same version twice is reported once", async () => {
    const h = setup();
    h.poller.start(v(5));
    await h.sched.advance(3_000);
    await h.respond(v(7));
    await h.sched.advance(3_000);
    await h.respond(v(7));
    await h.sched.advance(3_000);
    await h.respond(v(8));
    expect(h.onView.mock.calls.map(([x]) => x.version)).toEqual([7, 8]);
    expect(h.onSample).toHaveBeenCalledTimes(3);
  });
});

describe("§6 poller: stops when the game is over", () => {
  it.each(["finished", "abandoned"] as const)("a %s view calls onView, then stops with terminal", async (status) => {
    const h = setup();
    h.poller.start(v(5));
    await h.sched.advance(3_000);
    await h.respond(v(6, status));
    expect(h.log).toEqual(["sample", "view:6", "stop:terminal"]);
    expect(h.poller.running).toBe(false);
    await h.sched.advance(60_000);
    expect(h.fetches()).toBe(1);
  });

  it("a terminal view with no version bump still stops", async () => {
    const h = setup();
    h.poller.start(v(5));
    await h.sched.advance(3_000);
    await h.respond(v(5, "finished"));
    expect(h.onView).not.toHaveBeenCalled();
    expect(h.onStop).toHaveBeenCalledWith("terminal");
    expect(h.poller.running).toBe(false);
  });

  it("§6 the client never ends the game itself: an active view past endsAt keeps polling", async () => {
    const h = setup();
    const past = makeView({ version: 5 });
    h.poller.start(past);
    for (let i = 1; i <= 3; i++) {
      await h.sched.advance(3_000);
      await h.respond(makeView({ version: 5, serverNow: (past.game.endsAt ?? 0) + i * 3_000 }));
    }
    expect(h.fetches()).toBe(3);
    expect(h.onStop).not.toHaveBeenCalled();
  });
});

describe("§6 poller: kick", () => {
  it("while idle, cancels the pending timer and polls now", async () => {
    const h = setup();
    h.poller.start(v(5));
    await h.sched.advance(1_000);
    h.poller.kick();
    await flush();
    expect(h.fetches()).toBe(1);
    await h.respond(v(5)); // t=1000: next at 4000
    await h.sched.advance(2_000); // t=3000: the original timer must not fire
    expect(h.fetches()).toBe(1);
    await h.sched.advance(1_000); // t=4000
    expect(h.fetches()).toBe(2);
  });

  it("during a request, runs exactly one follow-up right after the response", async () => {
    const h = setup();
    h.poller.start(v(5));
    await h.sched.advance(3_000);
    h.poller.kick();
    await flush();
    expect(h.fetches()).toBe(1);
    await h.respond(v(5));
    expect(h.fetches()).toBe(2);
  });

  it("several kicks during a request still give one follow-up", async () => {
    const h = setup();
    h.poller.start(v(5));
    await h.sched.advance(3_000);
    h.poller.kick();
    h.poller.kick();
    h.poller.kick();
    await flush();
    expect(h.fetches()).toBe(1);
    await h.respond(v(5));
    expect(h.fetches()).toBe(2);
    await h.respond(v(5)); // the follow-up's response: back to the normal cadence
    expect(h.fetches()).toBe(2);
    await h.sched.advance(2_999);
    expect(h.fetches()).toBe(2);
    await h.sched.advance(1);
    expect(h.fetches()).toBe(3);
  });
});

describe("§6 poller: visibility", () => {
  it("start() while hidden fetches nothing", async () => {
    const h = setup();
    h.poller.setVisible(false);
    h.poller.start(v(5));
    await h.sched.advance(60_000);
    expect(h.fetches()).toBe(0);
  });

  it("becoming visible after starting hidden polls immediately", async () => {
    const h = setup();
    h.poller.setVisible(false);
    h.poller.start(v(5));
    await h.sched.advance(10_000);
    h.poller.setVisible(true);
    await flush();
    expect(h.fetches()).toBe(1);
  });

  it("hiding cancels the scheduled poll", async () => {
    const h = setup();
    h.poller.start(v(5));
    await h.sched.advance(1_000);
    h.poller.setVisible(false);
    await h.sched.advance(60_000);
    expect(h.fetches()).toBe(0);
    expect(h.sched.live()).toHaveLength(0);
  });

  it("visible again while running and idle polls immediately", async () => {
    const h = setup();
    h.poller.start(v(5));
    h.poller.setVisible(false);
    await h.sched.advance(30_000);
    h.poller.setVisible(true);
    await flush();
    expect(h.fetches()).toBe(1);
    await h.respond(v(5));
    await h.sched.advance(3_000);
    expect(h.fetches()).toBe(2);
  });

  it("hidden during a request: the response still fires callbacks but doesn't reschedule", async () => {
    const h = setup();
    h.poller.start(v(5));
    await h.sched.advance(3_000);
    h.poller.setVisible(false);
    await h.respond(v(6));
    expect(h.onSample).toHaveBeenCalledTimes(1);
    expect(h.onView).toHaveBeenCalledTimes(1);
    await h.sched.advance(60_000);
    expect(h.fetches()).toBe(1);
    expect(h.sched.live()).toHaveLength(0);
    h.poller.setVisible(true);
    await flush();
    expect(h.fetches()).toBe(2);
  });

  it("becoming visible before start() does not fetch", async () => {
    const h = setup();
    h.poller.setVisible(false);
    h.poller.setVisible(true);
    await h.sched.advance(10_000);
    expect(h.fetches()).toBe(0);
  });
});

describe("§6 poller: stop", () => {
  it("cancels the timer, calls onStop('stopped') once, and running becomes false", async () => {
    const h = setup();
    h.poller.start(v(5));
    h.poller.stop();
    expect(h.poller.running).toBe(false);
    expect(h.onStop).toHaveBeenCalledTimes(1);
    expect(h.onStop).toHaveBeenCalledWith("stopped");
    await h.sched.advance(60_000);
    expect(h.fetches()).toBe(0);
  });

  it("stopping twice is harmless", () => {
    const h = setup();
    h.poller.start(v(5));
    h.poller.stop();
    expect(() => h.poller.stop()).not.toThrow();
    expect(h.onStop).toHaveBeenCalledTimes(1);
  });

  it("aborts the in-flight request and ignores its late result", async () => {
    const h = setup();
    h.poller.start(v(5));
    await h.sched.advance(3_000);
    h.poller.stop();
    expect(h.calls[0]?.signal.aborted).toBe(true);
    await h.respond(v(9, "finished"));
    expect(h.onView).not.toHaveBeenCalled();
    expect(h.onSample).not.toHaveBeenCalled();
    expect(h.onStop).toHaveBeenCalledTimes(1);
    expect(h.onStop).toHaveBeenCalledWith("stopped");
    await h.sched.advance(60_000);
    expect(h.fetches()).toBe(1);
  });

  it("ignores a late error from the aborted request", async () => {
    const h = setup();
    h.poller.start(v(5));
    await h.sched.advance(3_000);
    h.poller.stop();
    await h.fail(new ApiError(404, "not_found", "No game"));
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onStop).toHaveBeenCalledTimes(1);
    expect(h.onStop).toHaveBeenCalledWith("stopped");
  });
});

describe("§6 §10 poller: 404 and 401 stop polling", () => {
  it.each([
    [404, "not_found", "notFound"],
    [401, "unauthorized", "unauthorized"],
  ] as const)("ApiError %d stops with %s", async (status, code, reason) => {
    const h = setup();
    h.poller.start(v(5));
    await h.sched.advance(3_000);
    await h.fail(new ApiError(status, code, "x"));
    expect(h.onStop).toHaveBeenCalledTimes(1);
    expect(h.onStop).toHaveBeenCalledWith(reason);
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.poller.running).toBe(false);
    await h.sched.advance(120_000);
    expect(h.fetches()).toBe(1);
  });
});

describe("§6 poller: errors back off", () => {
  async function failNTimes(h: ReturnType<typeof setup>, errs: unknown[]) {
    const delays: number[] = [];
    for (const err of errs) {
      const before = h.fetches();
      // advance to the next poll exactly
      const next = h.sched.live()[0];
      if (!next) throw new Error("nothing scheduled");
      await h.sched.advance(next.at - h.sched.now());
      expect(h.fetches()).toBe(before + 1);
      await h.fail(err);
      const scheduled = h.sched.live();
      expect(scheduled).toHaveLength(1);
      delays.push((scheduled[0] as Timer).ms);
    }
    return delays;
  }

  it("3000, 6000, 12000, 24000, 30000, 30000 with onError counting consecutive failures", async () => {
    const h = setup();
    h.poller.start(v(5));
    const errs = [
      new TypeError("network"),
      new ApiError(500, "internal", "x"),
      new ApiError(409, "busy", "x"),
      new Error("boom"),
      new TypeError("network"),
      new TypeError("network"),
    ];
    const delays = await failNTimes(h, errs);
    expect(delays).toEqual([3_000, 6_000, 12_000, 24_000, 30_000, 30_000]);
    expect(h.onError.mock.calls.map(([e, n]) => [e, n])).toEqual(errs.map((e, i) => [e, i + 1]));
    expect(h.poller.running).toBe(true);
    expect(h.onStop).not.toHaveBeenCalled();
  });

  it("the backoff is real time: no request before it elapses", async () => {
    const h = setup();
    h.poller.start(v(5));
    await h.sched.advance(3_000);
    await h.fail(new TypeError("network")); // next in 3000
    await h.sched.advance(3_000);
    await h.fail(new TypeError("network")); // next in 6000
    await h.sched.advance(5_999);
    expect(h.fetches()).toBe(2);
    await h.sched.advance(1);
    expect(h.fetches()).toBe(3);
  });

  it("a success resets the failure count", async () => {
    const h = setup();
    h.poller.start(v(5));
    await failNTimes(h, [new TypeError("a"), new TypeError("b"), new TypeError("c")]);
    await h.sched.advance(12_000); // the 12 s backoff elapses
    expect(h.fetches()).toBe(4);
    await h.respond(v(5));
    expect((h.sched.live()[0] as Timer).ms).toBe(3_000);
    const delays = await failNTimes(h, [new TypeError("d"), new TypeError("e")]);
    expect(delays).toEqual([3_000, 6_000]);
    expect(h.onError.mock.calls.map(([, n]) => n)).toEqual([1, 2, 3, 1, 2]);
  });

  it("honours custom intervalMs and maxBackoffMs", async () => {
    const h = setup({ intervalMs: 1_000, maxBackoffMs: 5_000 });
    h.poller.start(v(5));
    const delays = await failNTimes(h, [1, 2, 3, 4, 5].map((i) => new TypeError(String(i))));
    expect(delays).toEqual([1_000, 2_000, 4_000, 5_000, 5_000]);
  });
});

describe("§6 poller: accept (a write response)", () => {
  it("a newer version updates lastVersion without calling onView", async () => {
    const h = setup();
    h.poller.start(v(5));
    h.poller.accept(v(7));
    expect(h.onView).not.toHaveBeenCalled();
    await h.sched.advance(3_000);
    await h.respond(v(7)); // the poll sees what the write already returned
    expect(h.onView).not.toHaveBeenCalled();
    await h.sched.advance(3_000);
    await h.respond(v(8));
    expect(h.onView.mock.calls.map(([x]) => x.version)).toEqual([8]);
  });

  it("an older version doesn't lower lastVersion", async () => {
    const h = setup();
    h.poller.start(v(5));
    h.poller.accept(v(3));
    await h.sched.advance(3_000);
    await h.respond(v(4));
    expect(h.onView).not.toHaveBeenCalled();
  });

  it("a stale poll that was in flight during the write is ignored", async () => {
    const h = setup();
    h.poller.start(v(5));
    await h.sched.advance(3_000);
    h.poller.accept(v(7));
    await h.respond(v(6));
    expect(h.onView).not.toHaveBeenCalled();
  });

  it("when idle and visible, reschedules the next poll intervalMs from now", async () => {
    const h = setup();
    h.poller.start(v(5)); // poll due at 3000
    await h.sched.advance(2_000);
    h.poller.accept(v(6)); // now due at 5000
    await h.sched.advance(1_000); // t=3000
    expect(h.fetches()).toBe(0);
    await h.sched.advance(1_999); // t=4999
    expect(h.fetches()).toBe(0);
    await h.sched.advance(1); // t=5000
    expect(h.fetches()).toBe(1);
  });

  it("during a request, doesn't add another request", async () => {
    const h = setup();
    h.poller.start(v(5));
    await h.sched.advance(3_000);
    h.poller.accept(v(6));
    await h.sched.advance(10_000);
    expect(h.fetches()).toBe(1);
    await h.respond(v(6));
    expect(h.fetches()).toBe(1);
    await h.sched.advance(3_000);
    expect(h.fetches()).toBe(2);
  });

  it("while hidden, doesn't schedule a poll", async () => {
    const h = setup();
    h.poller.start(v(5));
    h.poller.setVisible(false);
    h.poller.accept(v(6));
    await h.sched.advance(60_000);
    expect(h.fetches()).toBe(0);
  });

  it.each(["finished", "abandoned"] as const)("a %s view stops with terminal", async (status) => {
    const h = setup();
    h.poller.start(v(5));
    h.poller.accept(v(6, status));
    expect(h.onView).not.toHaveBeenCalled();
    expect(h.onStop).toHaveBeenCalledTimes(1);
    expect(h.onStop).toHaveBeenCalledWith("terminal");
    expect(h.poller.running).toBe(false);
    await h.sched.advance(60_000);
    expect(h.fetches()).toBe(0);
  });
});
