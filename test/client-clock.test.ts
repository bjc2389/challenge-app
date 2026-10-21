// SPEC.md §6: the client uses serverNow to correct for clock drift and counts down to
// ends_at. At 0:00 it shows "Time!" and never decides the game has ended itself.
// Times are UTC epoch ms; every clock value here is passed in explicitly.
import { describe, expect, it } from "vitest";
import { betterSample, formatClock, isTimeUp, remainingMs, sampleOffset } from "../src/client/game/clock";

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

describe("§6 sampleOffset", () => {
  it("offset is serverNow minus the request midpoint; rtt is the round trip", () => {
    expect(sampleOffset(T0 + 10_000, T0 + 1_000, T0 + 1_200)).toEqual({ offsetMs: 8_900, rttMs: 200 });
  });

  it("a zero-latency, in-sync sample gives offset 0", () => {
    expect(sampleOffset(T0, T0, T0)).toEqual({ offsetMs: 0, rttMs: 0 });
  });

  it("a client clock ahead of the server gives a negative offset", () => {
    expect(sampleOffset(T0, T0 + 4_900, T0 + 5_100)).toEqual({ offsetMs: -5_000, rttMs: 200 });
  });
});

describe("§6 remainingMs corrects for client clock skew", () => {
  const endsAt = T0 + 3_600_000;
  const serverMid = T0 + 600_000; // server time when it answered: 50 min left
  const later = 125_000; // real time passed since then

  it.each([
    ["in sync", 0],
    ["5 minutes fast", 300_000],
    ["5 minutes slow", -300_000],
  ])("a client clock %s sees the same remaining time", (_name, skew) => {
    const sample = sampleOffset(serverMid, serverMid - 150 + skew, serverMid + 150 + skew);
    expect(sample.rttMs).toBe(300);
    const clientNow = serverMid + later + skew;
    expect(remainingMs(endsAt, sample.offsetMs, clientNow)).toBe(endsAt - (serverMid + later));
  });

  it("is endsAt - (now + offset)", () => {
    expect(remainingMs(T0 + 10_000, 2_000, T0)).toBe(8_000);
    expect(remainingMs(T0 + 10_000, -2_000, T0)).toBe(12_000);
  });

  it("goes negative after endsAt", () => {
    expect(remainingMs(T0, 0, T0 + 1_500)).toBe(-1_500);
  });

  it("is null before the game starts (no endsAt)", () => {
    expect(remainingMs(null, 0, T0)).toBeNull();
    expect(remainingMs(null, 5_000, T0)).toBeNull();
  });
});

describe("§6 betterSample keeps the lowest-latency sample", () => {
  const a = { offsetMs: 100, rttMs: 300 };
  const b = { offsetMs: 250, rttMs: 120 };

  it("null current gives next", () => {
    expect(betterSample(null, a)).toBe(a);
  });

  it("a lower rtt replaces the current sample", () => {
    expect(betterSample(a, b)).toBe(b);
  });

  it("a higher rtt keeps the current sample", () => {
    expect(betterSample(b, a)).toBe(b);
  });

  it("a tie keeps next", () => {
    const next = { offsetMs: -40, rttMs: 300 };
    expect(betterSample(a, next)).toBe(next);
  });
});

describe("§6 formatClock", () => {
  it.each([
    [3_600_000, "60:00"],
    [3_599_001, "60:00"],
    [3_599_000, "59:59"],
    [61_000, "1:01"],
    [60_001, "1:01"],
    [60_000, "1:00"],
    [545_000, "9:05"],
    [10_000, "0:10"],
    [1_001, "0:02"],
    [1_000, "0:01"],
    [1, "0:01"],
    [0, "Time!"],
    [-5, "Time!"],
    [-3_600_000, "Time!"],
  ])("%d ms -> %j", (ms, text) => {
    expect(formatClock(ms)).toBe(text);
  });
});

describe("§6 isTimeUp", () => {
  it.each([
    [null, false],
    [1, false],
    [60_000, false],
    [0, true],
    [-1, true],
    [-60_000, true],
  ])("%j -> %j", (ms, up) => {
    expect(isTimeUp(ms)).toBe(up);
  });
});
