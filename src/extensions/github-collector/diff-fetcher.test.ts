import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync } from "fs";
import { RequestError } from "@octokit/request-error";

const mockPullsGet = mock(async (_opts: unknown) => ({ data: "diff content" }));

mock.module("octokit", () => ({
  Octokit: class {
    rest = {
      pulls: { get: mockPullsGet },
    };
  },
}));

mock.module("../../config/settings", () => ({
  getSettings: () => ({ github: { token: "test-token" } }),
}));

const { fetchAndStoreDiff } = await import("./diff-fetcher");
const { RepoNotFoundError } = await import("./fetcher");

const TEST_DIFF_DIR = "data/diffs/test-org-test-repo";

function makeRequestError(status: number, rateLimitHeaders?: { remaining: string; reset: string }): RequestError {
  return new RequestError(`HTTP ${status}`, status, {
    request: { method: "GET", url: "https://api.github.com", headers: {} },
    response: {
      url: "https://api.github.com",
      status,
      headers: rateLimitHeaders
        ? { "x-ratelimit-remaining": rateLimitHeaders.remaining, "x-ratelimit-reset": rateLimitHeaders.reset }
        : {},
      data: {},
    },
  });
}

let originalSetTimeout: typeof globalThis.setTimeout;
function installFakeTimers() {
  originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (fn: () => void, _ms: number) =>
    originalSetTimeout(fn, 0);
}
function restoreRealTimers() {
  globalThis.setTimeout = originalSetTimeout;
}

beforeEach(() => {
  mockPullsGet.mockClear();
  try {
    rmSync(TEST_DIFF_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

afterEach(() => {
  if (originalSetTimeout) restoreRealTimers();
});

describe("fetchAndStoreDiff", () => {
  it("returns available status and stores patch file on success", async () => {
    mockPullsGet.mockResolvedValueOnce({ data: "diff --git a/file.ts b/file.ts\n..." });

    const result = await fetchAndStoreDiff("test-org", "test-repo", 1);

    expect(result.status).toBe("available");
    expect(result.path).toBe(`${TEST_DIFF_DIR}/1.patch`);
    expect(existsSync(result.path!)).toBe(true);
  });

  it("returns fetch_failed when API throws a generic error", async () => {
    mockPullsGet.mockRejectedValueOnce(new Error("network error"));

    const result = await fetchAndStoreDiff("test-org", "test-repo", 99);

    expect(result.status).toBe("fetch_failed");
    expect(result.path).toBeNull();
  });

  it("returns too_large and does not store file when diff exceeds 2MB", async () => {
    const bigDiff = "x".repeat(2_100_000);
    mockPullsGet.mockResolvedValueOnce({ data: bigDiff });

    const result = await fetchAndStoreDiff("test-org", "test-repo", 2);

    expect(result.status).toBe("too_large");
    expect(result.path).toBeNull();
    expect(existsSync(`${TEST_DIFF_DIR}/2.patch`)).toBe(false);
  });

  it("creates parent directory if it does not exist", async () => {
    mockPullsGet.mockResolvedValueOnce({ data: "small diff" });

    rmSync(TEST_DIFF_DIR, { recursive: true, force: true });
    expect(existsSync(TEST_DIFF_DIR)).toBe(false);

    const result = await fetchAndStoreDiff("test-org", "test-repo", 3);
    expect(result.status).toBe("available");
    expect(existsSync(TEST_DIFF_DIR)).toBe(true);
  });

  it("throws RepoNotFoundError on 404", async () => {
    mockPullsGet.mockRejectedValueOnce(makeRequestError(404));

    await expect(fetchAndStoreDiff("test-org", "test-repo", 404)).rejects.toThrow(
      RepoNotFoundError
    );
  });

  it("retries and succeeds after rate limit 403", async () => {
    installFakeTimers();
    const pastReset = String(Math.floor(Date.now() / 1000) - 10);
    mockPullsGet
      .mockRejectedValueOnce(makeRequestError(403, { remaining: "0", reset: pastReset }))
      .mockResolvedValueOnce({ data: "small diff" });

    const result = await fetchAndStoreDiff("test-org", "test-repo", 5);
    expect(result.status).toBe("available");
    expect(mockPullsGet.mock.calls).toHaveLength(2);
  });

  it("retries on 5xx and succeeds", async () => {
    installFakeTimers();
    mockPullsGet
      .mockRejectedValueOnce(makeRequestError(503))
      .mockResolvedValueOnce({ data: "small diff" });

    const result = await fetchAndStoreDiff("test-org", "test-repo", 6);
    expect(result.status).toBe("available");
    expect(mockPullsGet.mock.calls).toHaveLength(2);
  });

  it("returns fetch_failed after exhausting 5xx retries", async () => {
    installFakeTimers();
    mockPullsGet.mockRejectedValue(makeRequestError(500));

    const result = await fetchAndStoreDiff("test-org", "test-repo", 7);
    expect(result.status).toBe("fetch_failed");
    expect(mockPullsGet.mock.calls).toHaveLength(4); // 1 + 3 retries
  });
});
