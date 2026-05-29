import { describe, it, expect, mock, beforeEach } from "bun:test";

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

// Mock octokit module before importing fetcher
const mockPullsList = mock(async (_opts: unknown): Promise<{ data: MockPR[] }> => ({ data: [] }));
const mockReposGet = mock(
  async (_opts: unknown): Promise<{ data: MockRepoData }> => ({
    data: { description: null, language: null, topics: [] },
  })
);

mock.module("octokit", () => ({
  Octokit: class {
    rest = {
      pulls: { list: mockPullsList },
      repos: { get: mockReposGet },
    };
  },
}));

// Also mock settings so GITHUB_TOKEN is not required in tests
mock.module("../../config/settings", () => ({
  getSettings: () => ({ github: { token: "test-token" } }),
}));

const { fetchMergedPRs, fetchRepoMetadata } = await import("./fetcher");

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

beforeEach(() => {
  mockPullsList.mockClear();
  mockReposGet.mockClear();
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
});
