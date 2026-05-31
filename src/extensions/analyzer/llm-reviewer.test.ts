import { describe, it, expect, mock, afterEach } from "bun:test";
import { APICallError, NoObjectGeneratedError } from "ai";
import { withLLMRetry, MAX_LLM_RUN_RETRIES } from "./llm-retry";

// withLLMRetry is in llm-retry.ts which is NOT mocked by analyze.test.ts,
// so these tests work correctly in the full bun test suite run.

let originalSetTimeout: typeof globalThis.setTimeout;

function installFakeTimers() {
  originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (fn: () => void, _ms: number) =>
    originalSetTimeout(fn, 0);
}

function restoreRealTimers() {
  if (originalSetTimeout) globalThis.setTimeout = originalSetTimeout;
}

afterEach(() => {
  restoreRealTimers();
});

describe("withLLMRetry", () => {
  it("returns result on first successful call", async () => {
    const fn = mock(async () => "ok");

    const result = await withLLMRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries once on NoObjectGeneratedError and succeeds", async () => {
    const fn = mock(async () => "ok");
    fn.mockRejectedValueOnce(
      new NoObjectGeneratedError({ message: "schema fail", text: "", response: {} as any, usage: {} as any, cause: undefined })
    );

    const result = await withLLMRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after NoObjectGeneratedError exhausts retries", async () => {
    const fn = mock(async () => "ok");
    fn.mockRejectedValue(
      new NoObjectGeneratedError({ message: "schema fail", text: "", response: {} as any, usage: {} as any, cause: undefined })
    );

    await expect(withLLMRetry(fn)).rejects.toThrow("schema validation failed");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 rate limit with backoff", async () => {
    installFakeTimers();
    const fn = mock(async () => "ok");
    const rateLimitErr = new APICallError({
      url: "https://api.anthropic.com",
      statusCode: 429,
      requestBodyValues: {},
      message: "rate limited",
      isRetryable: true,
    });

    fn.mockRejectedValueOnce(rateLimitErr);

    const result = await withLLMRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after 429 exhausts retries", async () => {
    installFakeTimers();
    const fn = mock(async () => "ok");
    const rateLimitErr = new APICallError({
      url: "https://api.anthropic.com",
      statusCode: 429,
      requestBodyValues: {},
      message: "rate limited",
      isRetryable: true,
    });
    fn.mockRejectedValue(rateLimitErr);

    await expect(withLLMRetry(fn)).rejects.toBeInstanceOf(APICallError);
    expect(fn).toHaveBeenCalledTimes(MAX_LLM_RUN_RETRIES + 1);
  });

  it("retries on 500 server error with backoff", async () => {
    installFakeTimers();
    const fn = mock(async () => "ok");
    const serverErr = new APICallError({
      url: "https://api.anthropic.com",
      statusCode: 500,
      requestBodyValues: {},
      message: "server error",
      isRetryable: true,
    });

    fn.mockRejectedValueOnce(serverErr);

    const result = await withLLMRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after a server error fails twice", async () => {
    installFakeTimers();
    const fn = mock(async () => "ok");
    const serverErr = new APICallError({
      url: "https://api.anthropic.com",
      statusCode: 500,
      requestBodyValues: {},
      message: "server error",
      isRetryable: true,
    });
    fn.mockRejectedValue(serverErr);

    await expect(withLLMRetry(fn)).rejects.toBeInstanceOf(APICallError);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("propagates unknown error immediately without retrying", async () => {
    const fn = mock(async () => "ok");
    fn.mockRejectedValue(new Error("unexpected failure"));

    await expect(withLLMRetry(fn)).rejects.toThrow("unexpected failure");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects custom maxRunRetries", async () => {
    const fn = mock(async () => "ok");
    fn.mockRejectedValue(
      new NoObjectGeneratedError({ message: "fail", text: "", response: {} as any, usage: {} as any, cause: undefined })
    );

    await expect(withLLMRetry(fn, 1)).rejects.toThrow("schema validation failed");
    expect(fn).toHaveBeenCalledTimes(2); // 1 + 1 retry
  });
});
