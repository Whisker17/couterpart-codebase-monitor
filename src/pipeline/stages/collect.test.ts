import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "fs";
import type { PRData, RepoMetadata, PRStats } from "../../extensions/github-collector/fetcher";
import type { DiffResult } from "../../extensions/github-collector/diff-fetcher";
import type { CollectDeps, CollectOptions } from "./collect";

const TEST_DB_PATH = "data/test-collect-stage.db";
let testDb: Database;

// Use explicit parameter + return types so TS can index mock.calls[0]![2] as Date.
const mockFetchMergedPRs = mock(async (_org: string, _repo: string, _since: Date): Promise<PRData[]> => []);
const mockFetchRepoMetadata = mock(
  async (): Promise<RepoMetadata> => ({
    description: "Test repo",
    language: "TypeScript",
    topics: ["testing"],
  })
);
const mockFetchPRStats = mock(
  async (): Promise<PRStats> => ({ changed_files: 0, additions: 0, deletions: 0 })
);
const mockFetchAndStoreDiff = mock(
  async (): Promise<DiffResult> => ({ status: "available", path: "data/diffs/org-repo/1.patch" })
);

mock.module("../../storage/db", () => ({
  getDb: () => testDb,
}));

mock.module("../../config/projects", () => ({
  getTrackedProjects: () => [
    { org: "org", repo: "repo", url: "https://github.com/org/repo" },
    { org: "org2", repo: "repo2", url: "https://github.com/org2/repo2" },
  ],
}));

// Import execute after mocks are registered
const { execute } = await import("./collect");

// Build isolated deps for each test — pass functions directly to avoid mock.module
// on fetcher/diff-fetcher so those unit test files remain unaffected.
function makeDeps(): CollectDeps {
  return {
    fetchMergedPRs: mockFetchMergedPRs,
    fetchRepoMetadata: mockFetchRepoMetadata,
    fetchPRStats: mockFetchPRStats,
    fetchAndStoreDiff: mockFetchAndStoreDiff,
  };
}

function makeDb(): Database {
  const db = new Database(TEST_DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      org TEXT NOT NULL,
      repo TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT,
      language TEXT,
      topics TEXT,
      last_synced_at INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS pull_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      github_node_id TEXT,
      title TEXT NOT NULL,
      body TEXT,
      author TEXT,
      merged_at INTEGER,
      files_changed INTEGER,
      additions INTEGER,
      deletions INTEGER,
      diff_path TEXT,
      diff_status TEXT DEFAULT 'missing',
      analysis_status TEXT DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0,
      last_error TEXT,
      fetched_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(project_id, pr_number)
    );
  `);
  return db;
}

function makePR(overrides: { number: number; merged_at: Date }): PRData {
  return {
    number: overrides.number,
    title: `PR #${overrides.number}`,
    body: null,
    author: "author",
    merged_at: overrides.merged_at,
    changed_files: 0,
    additions: 0,
    deletions: 0,
    node_id: `node-${overrides.number}`,
  };
}

beforeEach(() => {
  testDb = makeDb();
  mockFetchMergedPRs.mockClear();
  mockFetchRepoMetadata.mockClear();
  mockFetchPRStats.mockClear();
  mockFetchAndStoreDiff.mockClear();
});

afterEach(() => {
  testDb.close();
  try {
    rmSync(TEST_DB_PATH, { force: true });
  } catch {
    // ignore
  }
});

describe("collect stage", () => {
  it("inserts projects into DB from config if not present", async () => {
    await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());

    const rows = testDb.query("SELECT id FROM projects").all();
    expect(rows.length).toBe(2);
  });

  it("is idempotent: running twice does not create duplicate projects", async () => {
    await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());
    await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());

    const rows = testDb.query("SELECT id FROM projects").all();
    expect(rows.length).toBe(2);
  });

  it("inserts PRs and sets diff_status correctly", async () => {
    const pr = makePR({ number: 42, merged_at: new Date("2024-01-15T00:00:00Z") });
    mockFetchMergedPRs.mockResolvedValueOnce([pr]).mockResolvedValueOnce([]);
    mockFetchAndStoreDiff.mockResolvedValueOnce({ status: "available", path: "data/diffs/org-repo/42.patch" });

    await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());

    const row = testDb
      .query("SELECT * FROM pull_requests WHERE pr_number = 42")
      .get() as { diff_status: string; diff_path: string } | null;
    expect(row).not.toBeNull();
    expect(row!.diff_status).toBe("available");
    expect(row!.diff_path).toBe("data/diffs/org-repo/42.patch");
  });

  it("writes non-zero changed_files/additions/deletions from fetchPRStats", async () => {
    const pr = makePR({ number: 7, merged_at: new Date("2024-01-20T00:00:00Z") });
    mockFetchMergedPRs.mockResolvedValueOnce([pr]).mockResolvedValueOnce([]);
    mockFetchPRStats.mockResolvedValueOnce({ changed_files: 8, additions: 200, deletions: 50 });
    mockFetchAndStoreDiff.mockResolvedValueOnce({ status: "available", path: "p" });

    await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());

    const row = testDb
      .query("SELECT files_changed, additions, deletions FROM pull_requests WHERE pr_number = 7")
      .get() as { files_changed: number; additions: number; deletions: number } | null;
    expect(row).not.toBeNull();
    expect(row!.files_changed).toBe(8);
    expect(row!.additions).toBe(200);
    expect(row!.deletions).toBe(50);
  });

  it("does not create duplicate PRs on second run (INSERT OR IGNORE)", async () => {
    const pr = makePR({ number: 42, merged_at: new Date("2024-01-15T00:00:00Z") });
    mockFetchMergedPRs.mockResolvedValue([pr]);
    mockFetchAndStoreDiff.mockResolvedValue({ status: "available", path: "data/diffs/org-repo/42.patch" });

    await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());
    await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());

    const rows = testDb
      .query("SELECT id FROM pull_requests WHERE pr_number = 42 AND project_id = 'org/repo'")
      .all();
    expect(rows.length).toBe(1);
  });

  it("updates last_synced_at to max(merged_at) not wall-clock now", async () => {
    const mergedAt = new Date("2024-01-15T12:00:00Z");
    const pr = makePR({ number: 1, merged_at: mergedAt });
    mockFetchMergedPRs.mockResolvedValueOnce([pr]).mockResolvedValueOnce([]);
    mockFetchAndStoreDiff.mockResolvedValueOnce({ status: "available", path: "p" });

    const before = Math.floor(Date.now() / 1000);
    await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());

    const row = testDb
      .query("SELECT last_synced_at FROM projects WHERE id = 'org/repo'")
      .get() as { last_synced_at: number } | null;

    const expectedUnix = Math.floor(mergedAt.getTime() / 1000);
    expect(row!.last_synced_at).toBe(expectedUnix);
    // Confirm it is NOT wall-clock now
    expect(row!.last_synced_at).toBeLessThan(before);
  });

  it("continues to next project when one fails", async () => {
    mockFetchMergedPRs
      .mockRejectedValueOnce(new Error("API rate limit exceeded"))
      .mockResolvedValueOnce([]);

    const result = await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());

    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("API rate limit exceeded");
    expect(result.failedProjects).toContain("org/repo");
    expect(result.failedProjects).not.toContain("org2/repo2");
  });

  it("still writes PR record when diff fetch fails", async () => {
    const pr = makePR({ number: 5, merged_at: new Date("2024-01-20T00:00:00Z") });
    mockFetchMergedPRs.mockResolvedValueOnce([pr]).mockResolvedValueOnce([]);
    mockFetchAndStoreDiff.mockResolvedValueOnce({ status: "fetch_failed", path: null });

    await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());

    const row = testDb
      .query("SELECT diff_status, diff_path FROM pull_requests WHERE pr_number = 5")
      .get() as { diff_status: string; diff_path: string | null } | null;
    expect(row).not.toBeNull();
    expect(row!.diff_status).toBe("fetch_failed");
    expect(row!.diff_path).toBeNull();
  });

  it("updates project metadata from GitHub", async () => {
    mockFetchMergedPRs.mockResolvedValue([]);
    mockFetchRepoMetadata.mockResolvedValueOnce({
      description: "Great project",
      language: "Rust",
      topics: ["systems", "cli"],
    });

    await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());

    const row = testDb
      .query("SELECT description, language, topics FROM projects WHERE id = 'org/repo'")
      .get() as { description: string; language: string; topics: string } | null;
    expect(row!.description).toBe("Great project");
    expect(row!.language).toBe("Rust");
    expect(JSON.parse(row!.topics)).toEqual(["systems", "cli"]);
  });

  it("returns itemsProcessed equal to total PR count across all projects", async () => {
    mockFetchMergedPRs
      .mockResolvedValueOnce([
        makePR({ number: 1, merged_at: new Date() }),
        makePR({ number: 2, merged_at: new Date() }),
      ])
      .mockResolvedValueOnce([makePR({ number: 3, merged_at: new Date() })]);
    mockFetchAndStoreDiff.mockResolvedValue({ status: "available", path: "p" });

    const result = await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());
    expect(result.itemsProcessed).toBe(3);
  });

  it("dateRangeOverride: excludes PRs outside the specified boundary", async () => {
    const startUnix = 1700000000;
    const endUnix = 1700086400;
    const inRange = makePR({ number: 10, merged_at: new Date(startUnix * 1000) });
    const beforeRange = makePR({ number: 11, merged_at: new Date((startUnix - 1) * 1000) });
    const afterRange = makePR({ number: 12, merged_at: new Date((endUnix + 1) * 1000) });
    // fetchMergedPRs is called with since=(startUnix-1)*1000, returns all three
    mockFetchMergedPRs.mockResolvedValueOnce([inRange, beforeRange, afterRange]).mockResolvedValueOnce([]);
    mockFetchAndStoreDiff.mockResolvedValue({ status: "available", path: "p" });

    const options: CollectOptions = { dateRangeOverride: { startUnix, endUnix } };
    await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps(), options);

    const rows = testDb.query("SELECT pr_number FROM pull_requests WHERE project_id = 'org/repo'").all() as { pr_number: number }[];
    const numbers = rows.map((r) => r.pr_number);
    expect(numbers).toContain(10);
    expect(numbers).not.toContain(11);
    expect(numbers).not.toContain(12);
  });

  it("dateRangeOverride: passes (startUnix - 1) as since to fetchMergedPRs", async () => {
    const startUnix = 1700000000;
    const endUnix = 1700086400;
    mockFetchMergedPRs.mockResolvedValue([]);

    const options: CollectOptions = { dateRangeOverride: { startUnix, endUnix } };
    await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps(), options);

    const callArg = mockFetchMergedPRs.mock.calls[0]![2] as Date;
    expect(callArg.getTime()).toBe((startUnix - 1) * 1000);
  });

  it("skipSyncUpdate: does not update last_synced_at when true", async () => {
    const mergedAt = new Date("2024-01-15T12:00:00Z");
    const pr = makePR({ number: 20, merged_at: mergedAt });
    mockFetchMergedPRs.mockResolvedValueOnce([pr]).mockResolvedValueOnce([]);
    mockFetchAndStoreDiff.mockResolvedValueOnce({ status: "available", path: "p" });

    const options: CollectOptions = { skipSyncUpdate: true };
    await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps(), options);

    const row = testDb
      .query("SELECT last_synced_at FROM projects WHERE id = 'org/repo'")
      .get() as { last_synced_at: number | null } | null;
    expect(row!.last_synced_at).toBeNull();
  });
});
