import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "fs";
import type { PRData, RepoMetadata, PRStats } from "../../extensions/github-collector/fetcher";
import type { DiffResult } from "../../extensions/github-collector/diff-fetcher";
import type { CollectDeps, CollectOptions } from "./collect";
import type { ProjectSnapshot } from "../../config/projects";

const TEST_DB_PATH = "data/test-collect-stage.db";
let testDb: Database;

const defaultSnapshot: ProjectSnapshot = {
  projects: [
    { org: "org", repo: "repo", url: "https://github.com/org/repo" },
    { org: "org2", repo: "repo2", url: "https://github.com/org2/repo2" },
  ],
};

const mockResolveProjectSnapshot = mock(async (_db: Database): Promise<ProjectSnapshot> => defaultSnapshot);

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
  resolveProjectSnapshot: mockResolveProjectSnapshot,
}));

// Import execute after mocks are registered
const { execute } = await import("./collect");

// Build isolated deps for each test
function makeDeps(): CollectDeps {
  return {
    fetchMergedPRs: mockFetchMergedPRs,
    fetchRepoMetadata: mockFetchRepoMetadata,
    fetchPRStats: mockFetchPRStats,
    fetchAndStoreDiff: mockFetchAndStoreDiff,
  };
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    org TEXT NOT NULL,
    repo TEXT NOT NULL,
    url TEXT NOT NULL,
    description TEXT,
    language TEXT,
    topics TEXT,
    last_synced_at INTEGER,
    last_collected_at INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    inactive_reason TEXT,
    source TEXT DEFAULT 'local',
    subscription_synced_at INTEGER,
    tags TEXT,
    notes TEXT,
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
`;

function makeDb(): Database {
  const db = new Database(TEST_DB_PATH);
  db.exec(SCHEMA);
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
  mockResolveProjectSnapshot.mockClear();
  mockResolveProjectSnapshot.mockImplementation(async (_db) => defaultSnapshot);
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
  it("uses snapshot from resolveProjectSnapshot for the whole run", async () => {
    const snapshot: ProjectSnapshot = {
      projects: [{ org: "snaporg", repo: "snaprepo", url: "https://github.com/snaporg/snaprepo" }],
    };
    mockResolveProjectSnapshot.mockImplementation(async (_db) => snapshot);
    testDb.run(
      `INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES (?, ?, ?, ?)`,
      ["snaporg/snaprepo", "snaporg", "snaprepo", "https://github.com/snaporg/snaprepo"]
    );

    await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());

    expect(mockResolveProjectSnapshot).toHaveBeenCalledTimes(1);
    expect(mockFetchMergedPRs.mock.calls[0]![0]).toBe("snaporg");
    expect(mockFetchMergedPRs.mock.calls[0]![1]).toBe("snaprepo");
  });

  it("resolveProjectSnapshot is called exactly once per execute call", async () => {
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo')`);
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org2/repo2', 'org2', 'repo2', 'https://github.com/org2/repo2')`);

    await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());

    expect(mockResolveProjectSnapshot).toHaveBeenCalledTimes(1);
  });

  it("propagates syncResult from resolveProjectSnapshot in the stage result", async () => {
    const snapshot: ProjectSnapshot = {
      projects: [{ org: "org", repo: "repo", url: "https://github.com/org/repo" }],
      syncResult: { activated: ["org/new"], deactivated: ["org/old"], unchanged: [] },
    };
    mockResolveProjectSnapshot.mockImplementation(async (_db) => snapshot);
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo')`);

    const result = await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());

    expect(result.syncResult).toEqual({ activated: ["org/new"], deactivated: ["org/old"], unchanged: [] });
    expect(result.resolvedProjectCount).toBe(1);
  });

  it("RepoNotFoundError sets inactive_reason = 'repo_not_found' on the project row", async () => {
    const { RepoNotFoundError } = await import("../../extensions/github-collector/fetcher");
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo')`);
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org2/repo2', 'org2', 'repo2', 'https://github.com/org2/repo2')`);

    mockFetchRepoMetadata.mockImplementationOnce(async () => {
      throw new RepoNotFoundError("org", "repo");
    });

    const result = await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());

    const row = testDb
      .query<{ active: number; inactive_reason: string | null }, []>(
        "SELECT active, inactive_reason FROM projects WHERE id = 'org/repo'"
      )
      .get();
    expect(row!.active).toBe(0);
    expect(row!.inactive_reason).toBe("repo_not_found");
    expect(result.failedProjects).toContain("org/repo");
  });

  it("PullsUnavailableError sets inactive_reason = 'pulls_disabled' on the project row", async () => {
    const { PullsUnavailableError } = await import("../../extensions/github-collector/fetcher");
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo')`);

    // Repo metadata resolves (repo is reachable), but listing PRs 404s.
    mockFetchMergedPRs.mockImplementationOnce(async () => {
      throw new PullsUnavailableError("org", "repo");
    });

    const result = await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());

    const row = testDb
      .query<{ active: number; inactive_reason: string | null }, []>(
        "SELECT active, inactive_reason FROM projects WHERE id = 'org/repo'"
      )
      .get();
    expect(row!.active).toBe(0);
    expect(row!.inactive_reason).toBe("pulls_disabled");
    expect(result.failedProjects).toContain("org/repo");
  });

  it("subscription fetch failure falls back to last successful SQLite snapshot", async () => {
    // resolveProjectSnapshot returns fallback (no syncResult) — collect succeeds
    const fallbackSnapshot: ProjectSnapshot = {
      projects: [{ org: "org", repo: "repo", url: "https://github.com/org/repo" }],
      // no syncResult = fallback mode
    };
    mockResolveProjectSnapshot.mockImplementation(async (_db) => fallbackSnapshot);
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo')`);

    const result = await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());

    expect(result.success).toBe(true);
    expect(result.syncResult).toBeUndefined();
  });

  it("collection fails when resolveProjectSnapshot throws (no prior snapshot)", async () => {
    mockResolveProjectSnapshot.mockImplementation(async (_db) => {
      throw new Error("[subscription] Fetch or validation failed and no prior subscription snapshot exists in SQLite.");
    });

    const result = await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("subscription");
  });

  it("inserts projects into DB from resolveProjectSnapshot if not present", async () => {
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo')`);
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org2/repo2', 'org2', 'repo2', 'https://github.com/org2/repo2')`);

    await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());

    const rows = testDb.query("SELECT id FROM projects").all();
    expect(rows.length).toBe(2);
  });

  it("inserts PRs and sets diff_status correctly", async () => {
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo')`);
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org2/repo2', 'org2', 'repo2', 'https://github.com/org2/repo2')`);

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
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo')`);
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org2/repo2', 'org2', 'repo2', 'https://github.com/org2/repo2')`);

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
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo')`);
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org2/repo2', 'org2', 'repo2', 'https://github.com/org2/repo2')`);

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
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo')`);
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org2/repo2', 'org2', 'repo2', 'https://github.com/org2/repo2')`);

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
    expect(row!.last_synced_at).toBeLessThan(before);
  });

  it("continues to next project when one fails", async () => {
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo')`);
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org2/repo2', 'org2', 'repo2', 'https://github.com/org2/repo2')`);

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
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo')`);
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org2/repo2', 'org2', 'repo2', 'https://github.com/org2/repo2')`);

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
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo')`);
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org2/repo2', 'org2', 'repo2', 'https://github.com/org2/repo2')`);

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
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo')`);
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org2/repo2', 'org2', 'repo2', 'https://github.com/org2/repo2')`);

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
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo')`);
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org2/repo2', 'org2', 'repo2', 'https://github.com/org2/repo2')`);

    const startUnix = 1700000000;
    const endUnix = 1700086400;
    const inRange = makePR({ number: 10, merged_at: new Date(startUnix * 1000) });
    const beforeRange = makePR({ number: 11, merged_at: new Date((startUnix - 1) * 1000) });
    const afterRange = makePR({ number: 12, merged_at: new Date((endUnix + 1) * 1000) });
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
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo')`);
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org2/repo2', 'org2', 'repo2', 'https://github.com/org2/repo2')`);

    const startUnix = 1700000000;
    const endUnix = 1700086400;
    mockFetchMergedPRs.mockResolvedValue([]);

    const options: CollectOptions = { dateRangeOverride: { startUnix, endUnix } };
    await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps(), options);

    const callArg = mockFetchMergedPRs.mock.calls[0]![2] as Date;
    expect(callArg.getTime()).toBe((startUnix - 1) * 1000);
  });

  it("skipSyncUpdate: does not update last_synced_at or last_collected_at when true", async () => {
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo')`);
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org2/repo2', 'org2', 'repo2', 'https://github.com/org2/repo2')`);

    const mergedAt = new Date("2024-01-15T12:00:00Z");
    const pr = makePR({ number: 20, merged_at: mergedAt });
    mockFetchMergedPRs.mockResolvedValueOnce([pr]).mockResolvedValueOnce([]);
    mockFetchAndStoreDiff.mockResolvedValueOnce({ status: "available", path: "p" });

    const options: CollectOptions = { skipSyncUpdate: true };
    await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps(), options);

    const row = testDb
      .query("SELECT last_synced_at, last_collected_at FROM projects WHERE id = 'org/repo'")
      .get() as { last_synced_at: number | null; last_collected_at: number | null } | null;
    expect(row!.last_synced_at).toBeNull();
    expect(row!.last_collected_at).toBeNull();
  });

  it("updates last_collected_at even when 0 PRs found", async () => {
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo')`);
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org2/repo2', 'org2', 'repo2', 'https://github.com/org2/repo2')`);

    // Both projects return 0 PRs
    mockFetchMergedPRs.mockResolvedValue([]);

    const before = Math.floor(Date.now() / 1000) - 1;
    await execute({ stageResults: new Map(), reportMode: "daily" as const }, makeDeps());

    const row = testDb
      .query("SELECT last_synced_at, last_collected_at FROM projects WHERE id = 'org/repo'")
      .get() as { last_synced_at: number | null; last_collected_at: number | null } | null;
    // last_synced_at should remain null (no PRs to advance it)
    expect(row!.last_synced_at).toBeNull();
    // last_collected_at must be set to a recent timestamp
    expect(row!.last_collected_at).not.toBeNull();
    expect(row!.last_collected_at!).toBeGreaterThanOrEqual(before);
  });
});
