import { afterEach, describe, expect, it, vi } from "vitest";
import { LOGIN_FAILURE_DELAY_MS, defaultDeps } from "../src/worker/app";

describe("§3 the real failed-login delay", () => {
  afterEach(() => vi.useRealTimers());

  it("waits the full second before resolving", async () => {
    vi.useFakeTimers();
    let done = false;
    const delayed = defaultDeps.delay(LOGIN_FAILURE_DELAY_MS).then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(LOGIN_FAILURE_DELAY_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await delayed;
    expect(done).toBe(true);
  });
});
