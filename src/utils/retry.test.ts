import { describe, it, expect, mock } from "bun:test";
import { withRetry } from "./retry";

describe("withRetry", () => {
  it("returns result on first attempt when fn succeeds", async () => {
    const fn = mock(async () => 42);
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0 });
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries and succeeds after initial failures", async () => {
    let calls = 0;
    const fn = mock(async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "ok";
    });
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws last error after maxRetries exhausted", async () => {
    const fn = mock(async () => {
      throw new Error("permanent");
    });
    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 })
    ).rejects.toThrow("permanent");
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("does not retry when retryOn returns false", async () => {
    const fn = mock(async () => {
      throw new Error("non-retryable");
    });
    await expect(
      withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        retryOn: () => false,
      })
    ).rejects.toThrow("non-retryable");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries when retryOn returns true", async () => {
    let calls = 0;
    const fn = mock(async () => {
      calls++;
      if (calls < 3) throw new Error("retryable");
      return "done";
    });
    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryOn: () => true,
    });
    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retryOn receives the thrown error", async () => {
    const seenErrors: string[] = [];
    const fn = mock(async () => {
      throw new Error("specific error");
    });
    await expect(
      withRetry(fn, {
        maxRetries: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        retryOn: (err) => {
          seenErrors.push(err.message);
          return true;
        },
      })
    ).rejects.toThrow();
    expect(seenErrors).toEqual(["specific error", "specific error"]);
  });

  it("caps delay at maxDelayMs", async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: () => void, ms: number) => {
      delays.push(ms);
      return originalSetTimeout(fn, 0);
    };

    let calls = 0;
    try {
      await withRetry(
        async () => {
          calls++;
          if (calls < 4) throw new Error("x");
          return "ok";
        },
        { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 200 }
      );
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
    }

    // delays for attempts 0, 1, 2: min(100*1, 200)=100, min(100*2, 200)=200, min(100*4, 200)=200
    expect(delays).toEqual([100, 200, 200]);
  });

  it("uses exponential backoff: baseDelay * 2^attempt", async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: () => void, ms: number) => {
      delays.push(ms);
      return originalSetTimeout(fn, 0);
    };

    let calls = 0;
    try {
      await withRetry(
        async () => {
          calls++;
          if (calls < 4) throw new Error("x");
          return "ok";
        },
        { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 10_000 }
      );
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
    }

    // attempt 0: 50*1=50, attempt 1: 50*2=100, attempt 2: 50*4=200
    expect(delays).toEqual([50, 100, 200]);
  });

  it("wraps non-Error throws in Error", async () => {
    const fn = mock(async () => {
      throw "string error"; // eslint-disable-line no-throw-literal
    });
    await expect(
      withRetry(fn, { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 })
    ).rejects.toThrow("string error");
  });
});
