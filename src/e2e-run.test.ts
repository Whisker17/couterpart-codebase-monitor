import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "fs";
import {
  getE2EStages,
  getExitCode,
  parseOptions,
  getRunStages,
  printPostRunSummary,
} from "./e2e-run";
import type { StageResult } from "./pipeline/runner";
import { getMonthPeriod, getPreviousMonthString, getYesterdayPeriod } from "./utils/time-window";

function result(success: boolean): StageResult {
  return { success, itemsProcessed: 0, errors: success ? [] : ["failed"], durationMs: 0 };
}

describe("e2e-run", () => {
  it("runs collect, analyze, impact-check, report, and dispatch in order", () => {
    expect(getE2EStages().map((stage) => stage.name)).toEqual([
      "collect",
      "analyze",
      "impact-check",
      "report",
      "dispatch",
    ]);
  });

  it("returns exit code 1 when any stage failed", () => {
    const results = new Map<string, StageResult>([
      ["collect", result(true)],
      ["analyze", result(true)],
      ["report", result(true)],
      ["dispatch", result(false)],
    ]);

    expect(getExitCode(results)).toBe(1);
  });

  it("returns exit code 0 when every stage succeeded", () => {
    const results = new Map<string, StageResult>([
      ["collect", result(true)],
      ["analyze", result(true)],
      ["report", result(true)],
      ["dispatch", result(true)],
    ]);

    expect(getExitCode(results)).toBe(0);
  });
});

describe("parseOptions", () => {
  it("defaults to daily mode with dispatch enabled", () => {
    expect(parseOptions([])).toEqual({ mode: "daily", noDispatch: false });
  });

  it("parses --mode daily", () => {
    expect(parseOptions(["--mode", "daily"])).toEqual({ mode: "daily", noDispatch: false });
  });

  it("parses --mode weekly", () => {
    expect(parseOptions(["--mode", "weekly"])).toEqual({ mode: "weekly", noDispatch: false });
  });

  it("parses --mode monthly", () => {
    expect(parseOptions(["--mode", "monthly"])).toEqual({ mode: "monthly", noDispatch: false });
  });

  it("parses --month for monthly report targeting", () => {
    expect(parseOptions(["--mode", "monthly", "--month", "2026-06"])).toEqual({
      mode: "monthly",
      noDispatch: false,
      month: "2026-06",
    });
  });

  it("parses --timezone override", () => {
    expect(parseOptions(["--mode", "monthly", "--timezone", "Asia/Shanghai"])).toEqual({
      mode: "monthly",
      noDispatch: false,
      timezone: "Asia/Shanghai",
    });
  });

  it("ignores invalid --month values", () => {
    expect(parseOptions(["--mode", "monthly", "--month", "2026-6"])).toEqual({
      mode: "monthly",
      noDispatch: false,
    });
  });

  it("parses --mode all", () => {
    expect(parseOptions(["--mode", "all"])).toEqual({ mode: "all", noDispatch: false });
  });

  it("parses --no-dispatch", () => {
    expect(parseOptions(["--no-dispatch"])).toEqual({ mode: "daily", noDispatch: true });
  });

  it("parses combined --mode all --no-dispatch", () => {
    expect(parseOptions(["--mode", "all", "--no-dispatch"])).toEqual({
      mode: "all",
      noDispatch: true,
    });
  });

  it("parses --no-dispatch before --mode", () => {
    expect(parseOptions(["--no-dispatch", "--mode", "weekly"])).toEqual({
      mode: "weekly",
      noDispatch: true,
    });
  });

  it("ignores unknown flags", () => {
    expect(parseOptions(["--foo", "--mode", "weekly"])).toEqual({
      mode: "weekly",
      noDispatch: false,
    });
  });

  it("ignores invalid mode values", () => {
    expect(parseOptions(["--mode", "invalid"])).toEqual({ mode: "daily", noDispatch: false });
  });
});

describe("getRunStages", () => {
  it("returns 5 stages when dispatch is enabled", () => {
    expect(getRunStages(false).map((s) => s.name)).toEqual([
      "collect",
      "analyze",
      "impact-check",
      "report",
      "dispatch",
    ]);
  });

  it("returns 4 stages without dispatch when noDispatch is true", () => {
    expect(getRunStages(true).map((s) => s.name)).toEqual([
      "collect",
      "analyze",
      "impact-check",
      "report",
    ]);
  });
});

describe("--mode all maps to all pipeline mode", () => {
  it("all mode with --no-dispatch selects 4 stages", () => {
    const { noDispatch } = parseOptions(["--mode", "all", "--no-dispatch"]);
    expect(getRunStages(noDispatch).map((s) => s.name)).toEqual([
      "collect",
      "analyze",
      "impact-check",
      "report",
    ]);
  });

  it("all mode without --no-dispatch selects 5 stages", () => {
    const { noDispatch } = parseOptions(["--mode", "all"]);
    expect(getRunStages(noDispatch).map((s) => s.name)).toEqual([
      "collect",
      "analyze",
      "impact-check",
      "report",
      "dispatch",
    ]);
  });
});

const E2E_SUMMARY_DB_PATH = "data/test-e2e-summary.db";

function applyE2ESummarySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      significance TEXT,
      direction_signal TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      estimated_cost_usd REAL,
      analyzed_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS pull_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      merged_at INTEGER,
      fetched_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(project_id, pr_number)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      project_ids TEXT,
      content TEXT NOT NULL,
      completeness TEXT,
      sent_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(type, period_start, period_end)
    );
    CREATE TABLE IF NOT EXISTS report_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL,
      card_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      lark_message_id TEXT,
      status TEXT DEFAULT 'pending',
      sent_at INTEGER
    );
  `);
}

describe("printPostRunSummary — no-data check uses merged_at", () => {
  let db: Database;
  const TZ = "UTC";

  beforeEach(() => {
    db = new Database(E2E_SUMMARY_DB_PATH);
    applyE2ESummarySchema(db);
  });

  afterEach(() => {
    db.close();
    try { rmSync(E2E_SUMMARY_DB_PATH); } catch { /* ignore */ }
  });

  it("prints [NO_DATA] when no analyses exist for yesterday's merged_at window", () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      printPostRunSummary("daily", true, new Map(), 0, db, TZ);
    } finally {
      console.log = orig;
    }
    expect(logs.some((l) => l.includes("[NO_DATA]"))).toBe(true);
    expect(logs.some((l) => l.includes("MISSING"))).toBe(false);
  });

  it("prints [NO_DATA] when PR was merged before yesterday's window", () => {
    const { startUnix } = getYesterdayPeriod(TZ);
    const beforeWindow = startUnix - 3600;
    const now = Math.floor(Date.now() / 1000);

    db.run(`INSERT INTO pull_requests (project_id, pr_number, title, merged_at, fetched_at) VALUES ('org/repo-a', 1, 'Old PR', ?, ?)`, [beforeWindow, now]);
    const pr = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
    db.run(`INSERT INTO analyses (pr_id, project_id, summary, analyzed_at) VALUES (?, 'org/repo-a', 'summary', ?)`, [pr.id, now]);

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      printPostRunSummary("daily", true, new Map(), 0, db, TZ);
    } finally {
      console.log = orig;
    }

    expect(logs.some((l) => l.includes("[NO_DATA]"))).toBe(true);
    expect(logs.some((l) => l.includes("MISSING"))).toBe(false);
  });

  it("prints MISSING when analyses exist for PRs merged yesterday but report is absent", () => {
    const { startUnix } = getYesterdayPeriod(TZ);
    const mergedYesterday = startUnix + 3600;
    const now = Math.floor(Date.now() / 1000);

    db.run(`INSERT INTO pull_requests (project_id, pr_number, title, merged_at, fetched_at) VALUES ('org/repo-a', 1, 'Yesterday PR', ?, ?)`, [mergedYesterday, now]);
    const pr = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
    db.run(`INSERT INTO analyses (pr_id, project_id, summary, analyzed_at) VALUES (?, 'org/repo-a', 'summary', ?)`, [pr.id, now]);

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      printPostRunSummary("daily", true, new Map(), 0, db, TZ);
    } finally {
      console.log = orig;
    }

    expect(logs.some((l) => l.includes("MISSING"))).toBe(true);
    expect(logs.some((l) => l.includes("[NO_DATA]"))).toBe(false);
  });

  it("returns exit code 1 when daily report is missing and merged_at analyses exist", () => {
    const { startUnix } = getYesterdayPeriod(TZ);
    const mergedYesterday = startUnix + 3600;
    const now = Math.floor(Date.now() / 1000);

    db.run(`INSERT INTO pull_requests (project_id, pr_number, title, merged_at, fetched_at) VALUES ('org/repo-a', 1, 'Yesterday PR', ?, ?)`, [mergedYesterday, now]);
    const pr = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
    db.run(`INSERT INTO analyses (pr_id, project_id, summary, analyzed_at) VALUES (?, 'org/repo-a', 'summary', ?)`, [pr.id, now]);

    const exitCode = printPostRunSummary("daily", true, new Map(), 0, db, TZ);
    expect(exitCode).toBe(1);
  });

  it("returns exit code 0 when daily report is missing and no merged_at analyses in window", () => {
    const exitCode = printPostRunSummary("daily", true, new Map(), 0, db, TZ);
    expect(exitCode).toBe(0);
  });

  it("prints monthly report when --mode monthly generated a monthly row", () => {
    const now = new Date("2026-06-10T12:00:00Z");
    const { startUnix, endUnix } = getMonthPeriod(TZ, getPreviousMonthString(TZ, now), now);
    db.run(
      `INSERT INTO reports (type, period_start, period_end, content) VALUES ('monthly', ?, ?, '{}')`,
      [startUnix, endUnix]
    );

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      printPostRunSummary("monthly", true, new Map(), 0, db, TZ, now);
    } finally {
      console.log = orig;
    }

    expect(logs.some((l) => l.includes("monthly"))).toBe(true);
    expect(logs.some((l) => l.includes("[SKIPPED] monthly"))).toBe(false);
  });
});
