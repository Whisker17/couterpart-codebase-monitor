import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "fs";

const TEST_DB_PATH = "data/test-budget-tracker.db";
let testDb: Database;

mock.module("../storage/db", () => ({
  getDb: () => testDb,
}));

mock.module("../config/settings", () => ({
  getSettings: () => ({
    budget: {
      monthlyCap: 100,
      warningThreshold: 0.8,
      cutoffThreshold: 1.0,
    },
  }),
}));

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_id INTEGER,
  project_id TEXT,
  summary TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost_usd REAL,
  analyzed_at INTEGER DEFAULT (unixepoch())
);
`;

const { getBudgetStatus } = await import("./budget-tracker");

function setupDb(): void {
  testDb = new Database(TEST_DB_PATH);
  testDb.exec(MIGRATION_SQL);
}

beforeEach(() => {
  setupDb();
});

afterEach(() => {
  testDb.close();
  try { rmSync(TEST_DB_PATH); } catch { /* ignore */ }
});

function insertAnalysis(costUsd: number): void {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const analyzedAt = Math.floor(monthStart.getTime() / 1000) + 86400; // 1 day into month
  testDb.run(
    `INSERT INTO analyses (pr_id, project_id, summary, input_tokens, output_tokens, estimated_cost_usd, analyzed_at)
     VALUES (1, 'org/repo', 'test', 1000, 200, ?, ?)`,
    [costUsd, analyzedAt]
  );
}

describe("getBudgetStatus", () => {
  it("returns normal action and zero stats when no analyses exist", () => {
    const status = getBudgetStatus();
    expect(status.action).toBe("normal");
    expect(status.estimatedCostUSD).toBe(0);
    expect(status.tokensUsedThisMonth).toBe(0);
    expect(status.usagePercent).toBe(0);
    expect(status.budgetCapUSD).toBe(100);
  });

  it("returns normal action when spend is below 80%", () => {
    insertAnalysis(60);
    const status = getBudgetStatus();
    expect(status.action).toBe("normal");
    expect(status.usagePercent).toBeCloseTo(0.6);
    expect(status.estimatedCostUSD).toBeCloseTo(60);
  });

  it("returns skip_routine action at exactly 80%", () => {
    insertAnalysis(80);
    const status = getBudgetStatus();
    expect(status.action).toBe("skip_routine");
    expect(status.usagePercent).toBeCloseTo(0.8);
  });

  it("returns skip_routine action between 80% and 100%", () => {
    insertAnalysis(85);
    const status = getBudgetStatus();
    expect(status.action).toBe("skip_routine");
    expect(status.usagePercent).toBeCloseTo(0.85);
  });

  it("returns pause action at exactly 100%", () => {
    insertAnalysis(100);
    const status = getBudgetStatus();
    expect(status.action).toBe("pause");
    expect(status.usagePercent).toBeCloseTo(1.0);
  });

  it("returns pause action when spend exceeds 100%", () => {
    insertAnalysis(120);
    const status = getBudgetStatus();
    expect(status.action).toBe("pause");
    expect(status.usagePercent).toBeCloseTo(1.2);
  });

  it("sums tokens across multiple analyses", () => {
    insertAnalysis(10);
    insertAnalysis(10);
    const status = getBudgetStatus();
    expect(status.tokensUsedThisMonth).toBe(2400); // 2 × (1000 input + 200 output)
    expect(status.estimatedCostUSD).toBeCloseTo(20);
  });

  it("excludes analyses from the previous month", () => {
    const now = new Date();
    const prevMonthTs = Math.floor(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15) / 1000
    );
    testDb.run(
      `INSERT INTO analyses (pr_id, project_id, summary, input_tokens, output_tokens, estimated_cost_usd, analyzed_at)
       VALUES (1, 'org/repo', 'old', 5000, 1000, 90, ?)`,
      [prevMonthTs]
    );
    const status = getBudgetStatus();
    expect(status.estimatedCostUSD).toBe(0);
    expect(status.action).toBe("normal");
  });
});
