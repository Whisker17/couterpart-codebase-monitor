import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";

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

const TEST_DIFF_DIR = "data/diffs/test-org-test-repo";

beforeEach(() => {
  mockPullsGet.mockClear();
  // Clean up any test diff files
  try {
    rmSync(TEST_DIFF_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("fetchAndStoreDiff", () => {
  it("returns available status and stores patch file on success", async () => {
    mockPullsGet.mockResolvedValueOnce({ data: "diff --git a/file.ts b/file.ts\n..." });

    const result = await fetchAndStoreDiff("test-org", "test-repo", 1);

    expect(result.status).toBe("available");
    expect(result.path).toBe(`${TEST_DIFF_DIR}/1.patch`);
    expect(existsSync(result.path!)).toBe(true);
  });

  it("returns fetch_failed when API throws", async () => {
    mockPullsGet.mockRejectedValueOnce(new Error("403 Forbidden"));

    const result = await fetchAndStoreDiff("test-org", "test-repo", 99);

    expect(result.status).toBe("fetch_failed");
    expect(result.path).toBeNull();
  });

  it("returns too_large and does not store file when diff exceeds 2MB", async () => {
    // Generate a string > 2MB
    const bigDiff = "x".repeat(2_100_000);
    mockPullsGet.mockResolvedValueOnce({ data: bigDiff });

    const result = await fetchAndStoreDiff("test-org", "test-repo", 2);

    expect(result.status).toBe("too_large");
    expect(result.path).toBeNull();
    expect(existsSync(`${TEST_DIFF_DIR}/2.patch`)).toBe(false);
  });

  it("creates parent directory if it does not exist", async () => {
    mockPullsGet.mockResolvedValueOnce({ data: "small diff" });

    // Ensure directory doesn't exist before call
    rmSync(TEST_DIFF_DIR, { recursive: true, force: true });
    expect(existsSync(TEST_DIFF_DIR)).toBe(false);

    const result = await fetchAndStoreDiff("test-org", "test-repo", 3);
    expect(result.status).toBe("available");
    expect(existsSync(TEST_DIFF_DIR)).toBe(true);
  });
});
