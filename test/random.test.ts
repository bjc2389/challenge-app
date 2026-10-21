// SPEC.md §5: the roll uses crypto randomness. cryptoRandomInt is the injected default.
import { describe, expect, it, vi } from "vitest";
import { defaultDeps } from "../src/worker/app";
import { cryptoRandomInt } from "../src/worker/random";

describe("§5 cryptoRandomInt", () => {
  it("returns 0 for maxExclusive 1", () => {
    for (let i = 0; i < 50; i++) expect(cryptoRandomInt(1)).toBe(0);
  });

  it.each([2, 3, 31, 1000])("returns integers in [0, %i)", (max) => {
    for (let i = 0; i < 500; i++) {
      const v = cryptoRandomInt(max);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(max);
    }
  });

  it("reaches every value in [0, 31) over many draws", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 3000; i++) seen.add(cryptoRandomInt(31));
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 31 }, (_, i) => i));
  });

  it("uses crypto.getRandomValues", () => {
    const spy = vi.spyOn(crypto, "getRandomValues");
    try {
      cryptoRandomInt(31);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("is the app's default random source", () => {
    expect(defaultDeps.randomInt).toBe(cryptoRandomInt);
  });
});
