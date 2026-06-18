import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { RequestError } from "@octokit/request-error";

type MockPR = {
  number: number;
  title: string;
  body: string | null;
  user: { login: string };
  merged_at: string | null;
  updated_at: string;
  node_id: string;
};

type MockRepoData = {
  description: string | null;
  language: string | null;
  topics: string[];
};

type MockPRDetail = {
  changed_files: number;
  additions: number;
  deletions: number;
};

// Mock octokit module before importing fetcher
const mockPullsList = mock(async (_opts: unknown): Promise<{ data: MockPR[] }> => ({ data: [] }));
const mockPullsGet = mock(
  async (_opts: unknown): Promise<{ data: MockPRDetail }> => ({
    data: { changed_files: 0, additions: 0, deletions: 0 },
  })
);
const mockReposGet = mock(
  async (_opts: unknown): Promise<{ data: MockRepoData }> => ({
    data: { description: null, language: null, topics: [] },
  })
);

mock.module("octokit", () => ({
  Octokit: class {
    rest = {
      pulls: { list: mockPullsList, get: mockPullsGet },
      repos: { get: mockReposGet },
    };
  },
}));

// Also mock settings so GITHUB_TOKEN is not required in tests
mock.module("../../config/settings", () => ({
  getSettings: () => ({ github: { token: "test-token" } }),
}));

const { fetchMergedPRs, fetchRepoMetadata, fetchPRStats, RepoNotFoundError, PullsUnavailableError } =
  await import("./fetcher");

function makePR(overrides: {
  number: number;
  merged_at: string | null;
  updated_at: string;
  node_id?: string;
}): MockPR {
  return {
    number: overrides.number,
    title: `PR #${overrides.number}`,
    body: null,
    user: { login: "author" },
    merged_at: overrides.merged_at,
    updated_at: overrides.updated_at,
    node_id: overrides.node_id ?? `node-${overrides.number}`,
  };
}

function makeRateLimitError(resetTimestamp: number): RequestError {
  return new RequestError("API rate limit exceeded", 403, {
    request: { method: "GET", url: "https://api.github.com", headers: {} },
    response: {
      url: "https://api.github.com",
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetTimestamp),
      },
      data: {},
    },
  });
}

function makeServerError(status: number): RequestError {
  return new RequestError(`Server error ${status}`, status, {
    request: { method: "GET", url: "https://api.github.com", headers: {} },
    response: {
      url: "https://api.github.com",
      status,
      headers: {},
      data: {},
    },
  });
}

function makeNotFoundError(): RequestError {
  return new RequestError("Not Found", 404, {
    request: { method: "GET", url: "https://api.github.com", headers: {} },
    response: {
      url: "https://api.github.com",
      status: 404,
      headers: {},
      data: {},
    },
  });
}

// Replace setTimeout with immediate version to avoid test delays
let originalSetTimeout: typeof globalThis.setTimeout | undefined;
function installFakeTimers() {
  const realSetTimeout = globalThis.setTimeout;
  originalSetTimeout = realSetTimeout;
  (globalThis as any).setTimeout = (fn: () => void, _ms: number) =>
    realSetTimeout(fn, 0);
}
function restoreRealTimers() {
  if (originalSetTimeout) globalThis.setTimeout = originalSetTimeout;
  originalSetTimeout = undefined;
}

beforeEach(() => {
  mockPullsList.mockClear();
  mockPullsGet.mockClear();
  mockReposGet.mockClear();
});

afterEach(() => {
  // Ensure timers are always restored even if test throws
  if (originalSetTimeout) restoreRealTimers();
});

describe("fetchMergedPRs", () => {
  it("returns only merged PRs that are newer than since", async () => {
    const since = new Date("2024-01-10T00:00:00Z");

    mockPullsList.mockResolvedValueOnce({
      data: [
        makePR({ number: 1, merged_at: "2024-01-15T00:00:00Z", updated_at: "2024-01-15T00:00:00Z" }),
        makePR({ number: 2, merged_at: null, updated_at: "2024-01-14T00:00:00Z" }),
        makePR({ number: 3, merged_at: "2024-01-05T00:00:00Z", updated_at: "2024-01-12T00:00:00Z" }),
      ],
    });

    const result = await fetchMergedPRs("org", "repo", since);

    // PR #1: merged after since ✓
    // PR #2: not merged ✗
    // PR #3: merged before since ✗
    expect(result).toHaveLength(1);
    expect(result[0]?.number).toBe(1);
  });

  it("stops paginating when updated_at is before since", async () => {
    const since = new Date("2024-01-10T00:00:00Z");

    // Page 1: all items updated after since → continue
    mockPullsList.mockResolvedValueOnce({
      data: Array.from({ length: 100 }, (_, i) =>
        makePR({ number: i + 1, merged_at: "2024-01-12T00:00:00Z", updated_at: "2024-01-12T00:00:00Z" })
      ),
    });
    // Page 2: first item updated before since → stop
    mockPullsList.mockResolvedValueOnce({
      data: [
        makePR({ number: 101, merged_at: "2024-01-08T00:00:00Z", updated_at: "2024-01-08T00:00:00Z" }),
      ],
    });

    await fetchMergedPRs("org", "repo", since);

    // Should have made exactly 2 API calls: page 1 triggered page 2, page 2 stopped
    expect(mockPullsList.mock.calls).toHaveLength(2);
  });

  it("stops when page returns fewer than 100 items without making another call", async () => {
    const since = new Date("2024-01-01T00:00:00Z");

    mockPullsList.mockResolvedValueOnce({
      data: [
        makePR({ number: 1, merged_at: "2024-01-10T00:00:00Z", updated_at: "2024-01-10T00:00:00Z" }),
      ],
    });

    const result = await fetchMergedPRs("org", "repo", since);
    expect(result).toHaveLength(1);
    expect(mockPullsList.mock.calls).toHaveLength(1);
  });

  it("returns empty array when no PRs match", async () => {
    const since = new Date("2024-12-01T00:00:00Z");

    mockPullsList.mockResolvedValueOnce({
      data: [
        makePR({ number: 1, merged_at: "2024-01-05T00:00:00Z", updated_at: "2024-01-06T00:00:00Z" }),
      ],
    });

    const result = await fetchMergedPRs("org", "repo", since);
    expect(result).toHaveLength(0);
  });

  it("returns correct PRData fields", async () => {
    const since = new Date("2024-01-01T00:00:00Z");

    mockPullsList.mockResolvedValueOnce({
      data: [
        {
          number: 42,
          title: "feat: add something",
          body: "Description here",
          user: { login: "dev" },
          merged_at: "2024-01-10T12:00:00Z",
          updated_at: "2024-01-10T12:00:00Z",
          node_id: "PR_abc123",
        },
      ],
    });

    const result = await fetchMergedPRs("org", "repo", since);
    expect(result).toHaveLength(1);
    const pr = result[0]!;
    expect(pr.number).toBe(42);
    expect(pr.title).toBe("feat: add something");
    expect(pr.body).toBe("Description here");
    expect(pr.author).toBe("dev");
    expect(pr.merged_at).toEqual(new Date("2024-01-10T12:00:00Z"));
    expect(pr.node_id).toBe("PR_abc123");
    expect(pr.changed_files).toBe(0);
  });

  it("throws PullsUnavailableError on a pulls 404 without retrying", async () => {
    // A 404 on the pulls endpoint means PRs are disabled — deterministic, so no retry.
    mockPullsList.mockRejectedValueOnce(makeNotFoundError());

    await expect(fetchMergedPRs("myorg", "myrepo", new Date())).rejects.toThrow(PullsUnavailableError);
    expect(mockPullsList.mock.calls).toHaveLength(1);
  });

  it("retries and succeeds after rate limit 403", async () => {
    installFakeTimers();
    const pastResetTimestamp = Math.floor(Date.now() / 1000) - 10;
    mockPullsList
      .mockRejectedValueOnce(makeRateLimitError(pastResetTimestamp))
      .mockResolvedValueOnce({ data: [] });

    const result = await fetchMergedPRs("org", "repo", new Date());
    expect(result).toHaveLength(0);
    expect(mockPullsList.mock.calls).toHaveLength(2);
  });

  it("retries on 5xx and succeeds", async () => {
    installFakeTimers();
    mockPullsList
      .mockRejectedValueOnce(makeServerError(503))
      .mockResolvedValueOnce({ data: [] });

    const result = await fetchMergedPRs("org", "repo", new Date());
    expect(result).toHaveLength(0);
    expect(mockPullsList.mock.calls).toHaveLength(2);
  });

  it("exhausts 5xx retries and throws after max retries", async () => {
    installFakeTimers();
    mockPullsList.mockRejectedValue(makeServerError(500));

    await expect(fetchMergedPRs("org", "repo", new Date())).rejects.toThrow("Server error 500");
    // 1 initial + 3 retries = 4 attempts
    expect(mockPullsList.mock.calls).toHaveLength(4);
  });
});

describe("fetchRepoMetadata", () => {
  it("returns description, language, and topics", async () => {
    mockReposGet.mockResolvedValueOnce({
      data: {
        description: "A test repo",
        language: "TypeScript",
        topics: ["web", "api"],
      },
    });

    const meta = await fetchRepoMetadata("org", "repo");
    expect(meta.description).toBe("A test repo");
    expect(meta.language).toBe("TypeScript");
    expect(meta.topics).toEqual(["web", "api"]);
  });

  it("returns null for missing description and language", async () => {
    mockReposGet.mockResolvedValueOnce({
      data: { description: null, language: null, topics: [] },
    });

    const meta = await fetchRepoMetadata("org", "repo");
    expect(meta.description).toBeNull();
    expect(meta.language).toBeNull();
    expect(meta.topics).toEqual([]);
  });

  it("retries a transient 404 then succeeds", async () => {
    installFakeTimers();
    mockReposGet
      .mockRejectedValueOnce(makeNotFoundError())
      .mockResolvedValueOnce({ data: { description: null, language: null, topics: [] } });

    const meta = await fetchRepoMetadata("org", "repo");
    expect(meta.description).toBeNull();
    expect(mockReposGet.mock.calls).toHaveLength(2);
  });

  it("throws RepoNotFoundError after exhausting 404 retries", async () => {
    installFakeTimers();
    mockReposGet
      .mockRejectedValueOnce(makeNotFoundError())
      .mockRejectedValueOnce(makeNotFoundError())
      .mockRejectedValueOnce(makeNotFoundError());
    await expect(fetchRepoMetadata("org", "deleted-repo")).rejects.toThrow(RepoNotFoundError);
    expect(mockReposGet.mock.calls).toHaveLength(3);
  });
});

describe("fetchPRStats", () => {
  it("returns changed_files, additions, deletions from pulls.get", async () => {
    mockPullsGet.mockResolvedValueOnce({
      data: { changed_files: 12, additions: 340, deletions: 55 },
    });

    const stats = await fetchPRStats("org", "repo", 42);
    expect(stats.changed_files).toBe(12);
    expect(stats.additions).toBe(340);
    expect(stats.deletions).toBe(55);
  });

  it("calls pulls.get with the correct PR number", async () => {
    mockPullsGet.mockResolvedValueOnce({
      data: { changed_files: 1, additions: 10, deletions: 5 },
    });

    await fetchPRStats("org", "repo", 99);

    expect(mockPullsGet.mock.calls).toHaveLength(1);
    const callArgs = mockPullsGet.mock.calls[0]?.[0] as { pull_number: number };
    expect(callArgs?.pull_number).toBe(99);
  });

  it("retries on 5xx server error", async () => {
    installFakeTimers();
    mockPullsGet
      .mockRejectedValueOnce(makeServerError(502))
      .mockResolvedValueOnce({ data: { changed_files: 3, additions: 10, deletions: 2 } });

    const stats = await fetchPRStats("org", "repo", 1);
    expect(stats.changed_files).toBe(3);
    expect(mockPullsGet.mock.calls).toHaveLength(2);
  });
});
