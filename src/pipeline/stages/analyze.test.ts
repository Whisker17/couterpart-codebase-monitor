import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync, mkdirSync } from "fs";

const TEST_DB_PATH = "data/test-analyze-stage.db";
let testDb: Database;

// Mock the LLM reviewer so tests don't make real API calls
const mockReviewPR = mock(async () => ({
  output: {
    summary: "Test summary",
    technical_detail: "Test detail",
    direction_signal: null,
    significance: "routine" as const,
    categories: ["testing" as const],
  },
  inputTokens: 1000,
  outputTokens: 200,
  estimatedCostUsd: 0.005,
  promptVersion: "v1",
  renderedProjectContext: "Test context",
  fileManifest: "File manifest",
  diffIncludedFiles: 1,
  diffTotalFiles: 1,
  diffTruncated: false,
  inputQuality: "diff_aware",
}));

mock.module("../../storage/db", () => ({
  getDb: () => testDb,
}));

mock.module("../../config/settings", () => ({
  getSettings: () => ({
    llm: {
      model: "claude-sonnet-4-6",
      baseUrl: "http://localhost",
      apiKey: "test",
      maxTokensPerCall: 4096,
      diffTokenBudget: 8000,
      maxManifestEntries: 100,
    },
    budget: {
      monthlyCap: 80,
      warningThreshold: 0.8,
      cutoffThreshold: 1.0,
    },
  }),
}));

mock.module("../../extensions/analyzer/llm-reviewer", () => ({
  reviewPR: mockReviewPR,
}));

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, org TEXT, repo TEXT, url TEXT,
  description TEXT, language TEXT, topics TEXT, overview TEXT
);
CREATE TABLE IF NOT EXISTS pull_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT, author TEXT,
  merged_at INTEGER, files_changed INTEGER, additions INTEGER, deletions INTEGER,
  diff_path TEXT,
  diff_status TEXT DEFAULT 'missing',
  analysis_status TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  last_error TEXT,
  fetched_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_id INTEGER NOT NULL, project_id TEXT NOT NULL,
  summary TEXT NOT NULL, technical_detail TEXT, direction_signal TEXT,
  significance TEXT, categories TEXT,
  model_id TEXT, input_tokens INTEGER, output_tokens INTEGER,
  estimated_cost_usd REAL,
  analyzed_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS analysis_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id INTEGER NOT NULL,
  prompt_version TEXT NOT NULL,
  input_quality TEXT NOT NULL,
  rendered_project_context TEXT,
  file_manifest TEXT,
  diff_included_files INTEGER,
  diff_total_files INTEGER,
  diff_truncated BOOLEAN NOT NULL,
  truncated_diff_path TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
`;

// Import after mocks
const { execute } = await import("./analyze");

function setupDb(): void {
  testDb = new Database(TEST_DB_PATH);
  testDb.exec(MIGRATION_SQL);
  testDb.run(
    `INSERT OR IGNORE INTO projects (id, org, repo, url, description, language, topics) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ["org/repo", "org", "repo", "https://github.com/org/repo", "Test project", "TypeScript", "[]"]
  );
}

function insertPR(overrides: Partial<{
  title: string;
  analysis_status: string;
  retry_count: number;
  diff_status: string;
  diff_path: string | null;
}> = {}): number {
  const opts = {
    title: "Test PR",
    analysis_status: "pending",
    retry_count: 0,
    diff_status: "missing",
    diff_path: null,
    ...overrides,
  };
  testDb.run(
    `INSERT INTO pull_requests (project_id, pr_number, title, analysis_status, retry_count, diff_status, diff_path, files_changed, additions, deletions)
     VALUES ('org/repo', ?, ?, ?, ?, ?, ?, 3, 50, 10)`,
    [Math.floor(Math.random() * 100000), opts.title, opts.analysis_status, opts.retry_count, opts.diff_status, opts.diff_path]
  );
  return (testDb.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!).id;
}

beforeEach(() => {
  setupDb();
  mockReviewPR.mockReset();
  mockReviewPR.mockImplementation(async () => ({
    output: {
      summary: "Test summary",
      technical_detail: "Test detail",
      direction_signal: null,
      significance: "routine" as const,
      categories: ["testing" as const],
    },
    inputTokens: 1000,
    outputTokens: 200,
    estimatedCostUsd: 0.005,
    promptVersion: "v1",
    renderedProjectContext: "Test context",
    fileManifest: "File manifest",
    diffIncludedFiles: 0,
    diffTotalFiles: 0,
    diffTruncated: false,
    inputQuality: "metadata_only",
  }));
});

afterEach(() => {
  testDb.close();
  try { rmSync(TEST_DB_PATH); } catch { /* ignore */ }
  try { rmSync("data/analysis-inputs", { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("analyze stage", () => {
  it("processes pending PRs and marks them complete", async () => {
    insertPR();
    const result = await execute({ stageResults: new Map(), isWeeklyRun: false });
    expect(result.itemsProcessed).toBe(1);

    const pr = testDb.query<{ analysis_status: string }, []>("SELECT analysis_status FROM pull_requests LIMIT 1").get();
    expect(pr?.analysis_status).toBe("complete");
  });

  it("writes analyses and analysis_inputs rows", async () => {
    insertPR();
    await execute({ stageResults: new Map(), isWeeklyRun: false });

    const analysis = testDb.query<{ summary: string; input_tokens: number }, []>("SELECT summary, input_tokens FROM analyses LIMIT 1").get();
    expect(analysis?.summary).toBe("Test summary");
    expect(analysis?.input_tokens).toBe(1000);

    const inputs = testDb.query<{ prompt_version: string; input_quality: string }, []>(
      "SELECT prompt_version, input_quality FROM analysis_inputs LIMIT 1"
    ).get();
    expect(inputs?.prompt_version).toBe("v1");
    expect(inputs?.input_quality).toBe("metadata_only");
  });

  it("marks PR failed and increments retry_count on LLM error", async () => {
    insertPR();
    mockReviewPR.mockImplementation(async () => { throw new Error("API error"); });

    const result = await execute({ stageResults: new Map(), isWeeklyRun: false });
    expect(result.itemsProcessed).toBe(0);
    expect(result.errors.length).toBe(1);

    const pr = testDb.query<{ analysis_status: string; retry_count: number; last_error: string }, []>(
      "SELECT analysis_status, retry_count, last_error FROM pull_requests LIMIT 1"
    ).get();
    expect(pr?.analysis_status).toBe("failed");
    expect(pr?.retry_count).toBe(1);
    expect(pr?.last_error).toContain("API error");
  });

  it("retries failed PRs with retry_count < 3", async () => {
    insertPR({ analysis_status: "failed", retry_count: 1 });
    const result = await execute({ stageResults: new Map(), isWeeklyRun: false });
    expect(result.itemsProcessed).toBe(1);

    const pr = testDb.query<{ analysis_status: string }, []>("SELECT analysis_status FROM pull_requests LIMIT 1").get();
    expect(pr?.analysis_status).toBe("complete");
  });

  it("excludes failed PRs with retry_count >= 3", async () => {
    insertPR({ analysis_status: "failed", retry_count: 3 });
    const result = await execute({ stageResults: new Map(), isWeeklyRun: false });
    expect(result.itemsProcessed).toBe(0);
    expect(mockReviewPR).not.toHaveBeenCalled();
  });

  it("does not block other PRs when one fails", async () => {
    insertPR({ title: "PR 1" });
    insertPR({ title: "PR 2" });

    let callCount = 0;
    mockReviewPR.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("fail first");
      return {
        output: { summary: "ok", technical_detail: "ok", direction_signal: null, significance: "routine" as const, categories: [] },
        inputTokens: 100,
        outputTokens: 20,
        estimatedCostUsd: 0.001,
        promptVersion: "v1",
        renderedProjectContext: "ctx",
        fileManifest: "",
        diffIncludedFiles: 0,
        diffTotalFiles: 0,
        diffTruncated: false,
        inputQuality: "metadata_only",
      };
    });

    const result = await execute({ stageResults: new Map(), isWeeklyRun: false });
    expect(result.itemsProcessed).toBe(1);
    expect(result.errors.length).toBe(1);
  });

  it("sets budgetExhausted when monthly cap is reached", async () => {
    // Insert a large spend to exceed the $80 cap
    testDb.run(
      `INSERT INTO analyses (pr_id, project_id, summary, input_tokens, output_tokens, estimated_cost_usd, analyzed_at)
       VALUES (1, 'org/repo', 'old', 100, 10, 90.0, unixepoch())` // $90 > $80 cap
    );
    insertPR();
    insertPR();

    const result = await execute({ stageResults: new Map(), isWeeklyRun: false });
    expect(result.budgetExhausted).toBe(true);
    expect((result.budgetSkippedCount ?? 0)).toBeGreaterThan(0);
    expect(mockReviewPR).not.toHaveBeenCalled();
  });

  it("uses metadata_only mode when diff_status is too_large", async () => {
    insertPR({ diff_status: "too_large" });
    await execute({ stageResults: new Map(), isWeeklyRun: false });

    const inputs = testDb.query<{ input_quality: string }, []>(
      "SELECT input_quality FROM analysis_inputs LIMIT 1"
    ).get();
    expect(inputs?.input_quality).toBe("metadata_only");
  });

  it("uses metadata_only mode when diff_status is missing", async () => {
    insertPR({ diff_status: "missing" });
    await execute({ stageResults: new Map(), isWeeklyRun: false });

    const inputs = testDb.query<{ input_quality: string }, []>(
      "SELECT input_quality FROM analysis_inputs LIMIT 1"
    ).get();
    expect(inputs?.input_quality).toBe("metadata_only");
  });
});
