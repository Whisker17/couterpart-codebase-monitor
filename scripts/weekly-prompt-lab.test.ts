import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { getWeekPeriod } from "../src/utils/time-window";
import {
  buildWeeklyPromptInput,
  parseArgs,
  renderPrompt,
  runWeeklyPromptLab,
} from "./weekly-prompt-lab";

function applySchema(db: Database): void {
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      org TEXT NOT NULL,
      repo TEXT NOT NULL,
      url TEXT NOT NULL
    );
    CREATE TABLE pull_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      author TEXT,
      merged_at INTEGER,
      files_changed INTEGER,
      additions INTEGER,
      deletions INTEGER,
      analysis_status TEXT DEFAULT 'complete'
    );
    CREATE TABLE analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      technical_detail TEXT,
      direction_signal TEXT,
      significance TEXT,
      categories TEXT,
      analyzed_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      content TEXT NOT NULL,
      digest_json TEXT
    );
    CREATE TABLE report_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL,
      card_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'pending'
    );
  `);
}

function insertAnalyzedPr(
  db: Database,
  params: {
    projectId: string;
    prNumber: number;
    title: string;
    mergedAt: number;
    summary: string;
    significance: "routine" | "notable" | "directional_shift";
    directionSignal?: string | null;
    categories?: string[];
  }
): void {
  const [org, repo] = params.projectId.split("/");
  db.run(
    "INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES (?, ?, ?, ?)",
    [params.projectId, org!, repo!, `https://github.com/${params.projectId}`]
  );
  db.run(
    `INSERT INTO pull_requests
       (project_id, pr_number, title, merged_at, files_changed, additions, deletions)
     VALUES (?, ?, ?, ?, 3, 20, 5)`,
    [params.projectId, params.prNumber, params.title, params.mergedAt]
  );
  const pr = db
    .query<{ id: number }, [string, number]>(
      "SELECT id FROM pull_requests WHERE project_id = ? AND pr_number = ?"
    )
    .get(params.projectId, params.prNumber)!;
  db.run(
    `INSERT INTO analyses
       (pr_id, project_id, summary, technical_detail, direction_signal, significance, categories)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      pr.id,
      params.projectId,
      params.summary,
      `${params.summary} technical detail`,
      params.directionSignal ?? null,
      params.significance,
      JSON.stringify(params.categories ?? []),
    ]
  );
}

describe("weekly prompt lab", () => {
  let db: Database;
  let tempDir: string;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    tempDir = mkdtempSync(join(tmpdir(), "weekly-prompt-lab-"));
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("parses prompt-lab CLI options", () => {
    const parsed = parseArgs([
      "--prompt",
      "prompts/reports/weekly/baseline.md",
      "--prompt",
      "prompts/reports/weekly/action.md",
      "--date",
      "2026-06-08",
      "--out",
      "data/reports/prompt-lab",
      "--dry-run",
      "--max-output-tokens",
      "2048",
    ]);

    expect(parsed.promptPaths).toEqual([
      "prompts/reports/weekly/baseline.md",
      "prompts/reports/weekly/action.md",
    ]);
    expect(parsed.date).toBe("2026-06-08");
    expect(parsed.outputRoot).toBe("data/reports/prompt-lab");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.maxOutputTokens).toBe(2048);
  });

  it("defaults to the weekly prompt directory and 8192 output tokens", () => {
    const parsed = parseArgs([]);

    expect(parsed.promptPaths).toEqual(["prompts/reports/weekly"]);
    expect(parsed.maxOutputTokens).toBe(8192);
  });

  it("renders prompt templates with weekly input JSON", () => {
    const rendered = renderPrompt(
      "Period: {{PERIOD_LABEL}}\nPRs: {{TOTAL_PRS}}\n{{WEEKLY_INPUT_JSON}}",
      {
        period: {
          startUnix: 1,
          endUnix: 2,
          startDate: "2026-06-01",
          endDate: "2026-06-07",
          label: "2026-06-01..2026-06-07",
          timezone: "UTC",
        },
        activitySummary: {
          totalPrs: 1,
          projectCount: 1,
          directionalShiftCount: 1,
          notableCount: 0,
          routineCount: 0,
        },
        dailyDigestCoverage: { present: 0, nullDigest: 0, missing: 7 },
        directionChanges: [],
        counterpartChecks: [],
        projects: [],
      }
    );

    expect(rendered).toContain("Period: 2026-06-01..2026-06-07");
    expect(rendered).toContain("PRs: 1");
    expect(rendered).toContain('"totalPrs": 1');
  });

  it("builds a full weekly prompt input from latest analyses in the current 7-day window", () => {
    const now = new Date("2026-06-08T12:00:00Z");
    const { startUnix, endUnix } = getWeekPeriod("UTC", now);
    const midWeek = startUnix + 3600;

    insertAnalyzedPr(db, {
      projectId: "org/repo-a",
      prNumber: 1,
      title: "Migrate RPC",
      mergedAt: midWeek,
      summary: "Moves RPC handlers to a new router",
      significance: "directional_shift",
      directionSignal: "RPC architecture is moving toward a centralized router",
      categories: ["architecture", "api"],
    });
    insertAnalyzedPr(db, {
      projectId: "org/repo-a",
      prNumber: 2,
      title: "Fix typo",
      mergedAt: midWeek + 60,
      summary: "Fixes documentation typo",
      significance: "routine",
      categories: ["docs"],
    });
    insertAnalyzedPr(db, {
      projectId: "org/repo-a",
      prNumber: 3,
      title: "Old PR",
      mergedAt: startUnix - 60,
      summary: "Outside period",
      significance: "notable",
    });

    const input = buildWeeklyPromptInput(db, "UTC", now);

    expect(input.period.startUnix).toBe(startUnix);
    expect(input.period.endUnix).toBe(endUnix);
    expect(input.activitySummary.totalPrs).toBe(2);
    expect(input.activitySummary.directionalShiftCount).toBe(1);
    expect(input.activitySummary.routineCount).toBe(1);
    expect(input.projects).toHaveLength(1);
    expect(input.projects[0]!.prs.map((pr) => pr.prNumber)).toEqual([1, 2]);
    expect(input.projects[0]!.topSignals).toEqual([
      "RPC architecture is moving toward a centralized router",
    ]);
    expect(input.directionChanges[0]!.projectId).toBe("org/repo-a");
  });

  it("writes prompt comparison outputs without mutating production report tables", async () => {
    const now = new Date("2026-06-08T12:00:00Z");
    const { startUnix } = getWeekPeriod("UTC", now);
    insertAnalyzedPr(db, {
      projectId: "org/repo-a",
      prNumber: 10,
      title: "Speed up prover",
      mergedAt: startUnix + 3600,
      summary: "Improves prover throughput",
      significance: "notable",
      directionSignal: "Performance work is becoming visible",
      categories: ["performance"],
    });

    const promptDir = join(tempDir, "prompts");
    const outputRoot = join(tempDir, "out");
    mkdirSync(promptDir, { recursive: true });
    writeFileSync(join(promptDir, "baseline.md"), "Baseline {{PERIOD_LABEL}}\n{{WEEKLY_INPUT_JSON}}", {
      flag: "wx",
    });
    writeFileSync(join(promptDir, "action.md"), "Action {{TOTAL_PRS}}\n{{WEEKLY_INPUT_JSON}}", {
      flag: "wx",
    });

    const result = await runWeeklyPromptLab(
      {
        promptPaths: [promptDir],
        outputRoot,
        timezone: "UTC",
        now,
        runId: "test-run",
        dryRun: false,
        maxOutputTokens: 8192,
      },
      {
        db,
        generateFn: async ({ prompt }) => ({
          text: prompt.startsWith("Baseline")
            ? "# Baseline output\n"
            : "# Action output\n",
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
      }
    );

    const reportCount = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM reports").get()!.n;
    const deliveryCount = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM report_deliveries")
      .get()!.n;
    expect(reportCount).toBe(0);
    expect(deliveryCount).toBe(0);

    const runDir = result.outputDir;
    expect((await stat(join(runDir, "input.json"))).isFile()).toBe(true);
    expect((await stat(join(runDir, "index.md"))).isFile()).toBe(true);

    const variants = (await readdir(runDir)).filter((name) => name !== "input.json" && name !== "index.md");
    expect(variants.sort()).toEqual(["action", "baseline"]);
    expect(await readFile(join(runDir, "baseline", "output.md"), "utf-8")).toContain(
      "# Baseline output"
    );
    expect(await readFile(join(runDir, "action", "output.md"), "utf-8")).toContain(
      "# Action output"
    );
  });
});
