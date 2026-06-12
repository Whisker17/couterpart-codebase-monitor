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
    impactCheck: {
      monthlySubCap: 50,
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
CREATE TABLE IF NOT EXISTS impact_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimated_cost_usd REAL,
  analyzed_at INTEGER DEFAULT (unixepoch())
);
`;

const { getBudgetStatus, getImpactCheckBudgetStatus } = await import("./budget-tracker");

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

function insertImpactCheck(costUsd: number): void {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const analyzedAt = Math.floor(monthStart.getTime() / 1000) + 86400; // 1 day into month
  testDb.run(
    `INSERT INTO impact_checks (estimated_cost_usd, analyzed_at) VALUES (?, ?)`,
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

describe("getBudgetStatus two-table sum", () => {
  it("includes impact_check costs in the monthly total", () => {
    insertAnalysis(30);
    insertImpactCheck(20);
    const status = getBudgetStatus();
    expect(status.estimatedCostUSD).toBeCloseTo(50);
    expect(status.usagePercent).toBeCloseTo(0.5);
    expect(status.action).toBe("normal");
  });

  it("combined analyses + impact_checks crosses warning threshold", () => {
    insertAnalysis(50);
    insertImpactCheck(35);
    const status = getBudgetStatus();
    expect(status.estimatedCostUSD).toBeCloseTo(85);
    expect(status.action).toBe("skip_routine");
  });

  it("combined cost reaches monthlyCap and triggers pause", () => {
    insertAnalysis(70);
    insertImpactCheck(30);
    const status = getBudgetStatus();
    expect(status.estimatedCostUSD).toBeCloseTo(100);
    expect(status.action).toBe("pause");
  });

  it("impact_check costs from previous month are excluded from total", () => {
    const now = new Date();
    const prevMonthTs = Math.floor(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15) / 1000
    );
    testDb.run(
      `INSERT INTO impact_checks (estimated_cost_usd, analyzed_at) VALUES (?, ?)`,
      [90, prevMonthTs]
    );
    const status = getBudgetStatus();
    expect(status.estimatedCostUSD).toBe(0);
    expect(status.action).toBe("normal");
  });
});

describe("getImpactCheckBudgetStatus", () => {
  it("returns normal with zero cost when no impact checks exist", () => {
    const status = getImpactCheckBudgetStatus();
    expect(status.action).toBe("normal");
    expect(status.estimatedCostUSD).toBe(0);
    expect(status.usagePercent).toBe(0);
    expect(status.budgetCapUSD).toBe(50);
  });

  it("returns normal when impact check spend is below sub-cap", () => {
    insertImpactCheck(20);
    const status = getImpactCheckBudgetStatus();
    expect(status.action).toBe("normal");
    expect(status.estimatedCostUSD).toBeCloseTo(20);
    expect(status.usagePercent).toBeCloseTo(0.4);
    expect(status.budgetCapUSD).toBe(50);
  });

  it("returns pause when impact check spend reaches sub-cap exactly", () => {
    insertImpactCheck(50);
    const status = getImpactCheckBudgetStatus();
    expect(status.action).toBe("pause");
    expect(status.usagePercent).toBeCloseTo(1.0);
  });

  it("returns pause when impact check spend exceeds sub-cap", () => {
    insertImpactCheck(60);
    const status = getImpactCheckBudgetStatus();
    expect(status.action).toBe("pause");
    expect(status.usagePercent).toBeCloseTo(1.2);
  });

  it("sums multiple impact check rows", () => {
    insertImpactCheck(15);
    insertImpactCheck(20);
    const status = getImpactCheckBudgetStatus();
    expect(status.estimatedCostUSD).toBeCloseTo(35);
    expect(status.action).toBe("normal");
  });

  it("excludes impact checks from the previous month", () => {
    const now = new Date();
    const prevMonthTs = Math.floor(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15) / 1000
    );
    testDb.run(
      `INSERT INTO impact_checks (estimated_cost_usd, analyzed_at) VALUES (?, ?)`,
      [60, prevMonthTs]
    );
    const status = getImpactCheckBudgetStatus();
    expect(status.estimatedCostUSD).toBe(0);
    expect(status.action).toBe("normal");
  });
});

describe("gate independence", () => {
  it("impact_check sub-cap pause does not affect getBudgetStatus action", () => {
    // Impact checks exceed sub-cap ($50) but combined total is only 55/100 = 55% of monthlyCap
    insertImpactCheck(55);
    insertAnalysis(0);

    const impactStatus = getImpactCheckBudgetStatus();
    expect(impactStatus.action).toBe("pause");

    const budgetStatus = getBudgetStatus();
    // 55 < 80% of 100, so PR analysis gate is unaffected
    expect(budgetStatus.action).toBe("normal");
    expect(budgetStatus.estimatedCostUSD).toBeCloseTo(55);
  });

  it("analyses-only cost does not affect getImpactCheckBudgetStatus", () => {
    insertAnalysis(95); // near monthlyCap
    const impactStatus = getImpactCheckBudgetStatus();
    expect(impactStatus.estimatedCostUSD).toBe(0);
    expect(impactStatus.action).toBe("normal");
  });
});
