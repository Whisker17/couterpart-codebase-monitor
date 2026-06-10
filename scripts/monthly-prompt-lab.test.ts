import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getMonthPeriod } from "../src/utils/time-window";
import {
  buildMonthlyPromptInput,
  parseArgs,
  renderPrompt,
  runMonthlyPromptLab,
} from "./monthly-prompt-lab";

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
     VALUES (?, ?, ?, ?, 8, 120, 40)`,
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

describe("monthly prompt lab", () => {
  let db: Database;
  let tempDir: string;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    tempDir = mkdtempSync(join(tmpdir(), "monthly-prompt-lab-"));
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("parses prompt-lab CLI options", () => {
    const parsed = parseArgs([
      "--prompt",
      "prompts/reports/monthly/executive-trajectory.md",
      "--prompt",
      "prompts/reports/monthly/strategic-action.md",
      "--month",
      "2026-06",
      "--out",
      "data/reports/prompt-lab",
      "--dry-run",
      "--max-output-tokens",
      "4096",
    ]);

    expect(parsed.promptPaths).toEqual([
      "prompts/reports/monthly/executive-trajectory.md",
      "prompts/reports/monthly/strategic-action.md",
    ]);
    expect(parsed.month).toBe("2026-06");
    expect(parsed.outputRoot).toBe("data/reports/prompt-lab");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.maxOutputTokens).toBe(4096);
  });

  it("defaults to the monthly prompt directory and 8192 output tokens", () => {
    const parsed = parseArgs([]);

    expect(parsed.promptPaths).toEqual(["prompts/reports/monthly"]);
    expect(parsed.maxOutputTokens).toBe(8192);
  });

  it("renders prompt templates with monthly input JSON", () => {
    const rendered = renderPrompt(
      "Period: {{PERIOD_LABEL}}\nPRs: {{TOTAL_PRS}}\n{{MONTHLY_INPUT_JSON}}",
      {
        period: {
          startUnix: 1,
          endUnix: 2,
          startDate: "2026-06-01",
          endDate: "2026-06-08",
          month: "2026-06",
          label: "2026-06-01..2026-06-08 (month-to-date)",
          timezone: "UTC",
          isPartial: true,
          completedDays: 8,
        },
        activitySummary: {
          totalPrs: 1,
          projectCount: 1,
          directionalShiftCount: 1,
          notableCount: 0,
          routineCount: 0,
        },
        coverage: {
          dailyReports: { present: 0, nullDigest: 0, missing: 8 },
          weeklyReports: { present: 0, nullDigest: 0 },
        },
        monthlyShape: {
          categoryCounts: [],
          narrativeSignals: [],
          timeBuckets: [],
        },
        projects: [],
      }
    );

    expect(rendered).toContain("Period: 2026-06-01..2026-06-08 (month-to-date)");
    expect(rendered).toContain("PRs: 1");
    expect(rendered).toContain('"month": "2026-06"');
  });

  it("builds compressed monthly prompt input from latest analyses", () => {
    const now = new Date("2026-06-09T12:00:00Z");
    const { startUnix, endUnix } = getMonthPeriod("UTC", "2026-06", now);

    insertAnalyzedPr(db, {
      projectId: "org/repo-a",
      prNumber: 1,
      title: "Launch settlement layer",
      mergedAt: startUnix + 3600,
      summary: "Moves the project toward settlement-layer positioning",
      significance: "directional_shift",
      directionSignal: "Settlement layer narrative is becoming explicit",
      categories: ["architecture", "strategy"],
    });
    insertAnalyzedPr(db, {
      projectId: "org/repo-a",
      prNumber: 2,
      title: "Harden API",
      mergedAt: startUnix + 86_400 * 5,
      summary: "Tightens public API behavior",
      significance: "notable",
      directionSignal: "API surface is stabilizing",
      categories: ["api"],
    });
    insertAnalyzedPr(db, {
      projectId: "org/repo-b",
      prNumber: 3,
      title: "Fix docs",
      mergedAt: startUnix + 86_400,
      summary: "Updates documentation",
      significance: "routine",
      categories: ["docs"],
    });
    insertAnalyzedPr(db, {
      projectId: "org/repo-a",
      prNumber: 4,
      title: "Old PR",
      mergedAt: startUnix - 60,
      summary: "Outside period",
      significance: "notable",
    });

    db.run(
      "INSERT INTO reports (type, period_start, period_end, content, digest_json) VALUES ('daily', ?, ?, 'x', '{}')",
      [startUnix, startUnix + 86_399]
    );

    const input = buildMonthlyPromptInput(db, "UTC", { month: "2026-06", now });

    expect(input.period.startUnix).toBe(startUnix);
    expect(input.period.endUnix).toBe(endUnix);
    expect(input.period.isPartial).toBe(true);
    expect(input.period.completedDays).toBe(8);
    expect(input.activitySummary.totalPrs).toBe(3);
    expect(input.activitySummary.directionalShiftCount).toBe(1);
    expect(input.activitySummary.notableCount).toBe(1);
    expect(input.activitySummary.routineCount).toBe(1);
    expect(input.coverage.dailyReports.present).toBe(1);
    expect(input.coverage.dailyReports.missing).toBe(7);
    expect(input.projects).toHaveLength(2);
    expect(input.projects[0]!.projectId).toBe("org/repo-a");
    expect(input.projects[0]!.representativePrs.map((pr) => pr.prNumber)).toEqual([1, 2]);
    expect(input.projects[0]!.topSignals).toEqual([
      "Settlement layer narrative is becoming explicit",
      "API surface is stabilizing",
    ]);
    expect(input.monthlyShape.categoryCounts[0]).toEqual({ category: "api", count: 1 });
    expect(input.monthlyShape.narrativeSignals[0]!.signal).toBe("API surface is stabilizing");
    expect(input.monthlyShape.timeBuckets[0]!.totalPrs).toBe(3);
  });

  it("writes prompt comparison outputs without mutating production report tables", async () => {
    const now = new Date("2026-06-09T12:00:00Z");
    const { startUnix } = getMonthPeriod("UTC", "2026-06", now);
    insertAnalyzedPr(db, {
      projectId: "org/repo-a",
      prNumber: 10,
      title: "New prover market signal",
      mergedAt: startUnix + 3600,
      summary: "Shows a stronger external prover market direction",
      significance: "notable",
      directionSignal: "External prover market narrative is strengthening",
      categories: ["strategy"],
    });

    const promptDir = join(tempDir, "prompts");
    const outputRoot = join(tempDir, "out");
    mkdirSync(promptDir, { recursive: true });
    writeFileSync(
      join(promptDir, "executive.md"),
      "Executive {{PERIOD_LABEL}}\n{{MONTHLY_INPUT_JSON}}",
      { flag: "wx" }
    );
    writeFileSync(join(promptDir, "action.md"), "Action {{TOTAL_PRS}}\n{{MONTHLY_INPUT_JSON}}", {
      flag: "wx",
    });

    const result = await runMonthlyPromptLab(
      {
        promptPaths: [promptDir],
        outputRoot,
        timezone: "UTC",
        month: "2026-06",
        now,
        runId: "test-run",
        dryRun: false,
        maxOutputTokens: 8192,
      },
      {
        db,
        generateFn: async ({ prompt }) => ({
          text: prompt.startsWith("Executive")
            ? "# Executive output\n"
            : "# Action output\n",
          usage: { inputTokens: 12, outputTokens: 6 },
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
    expect(variants.sort()).toEqual(["action", "executive"]);
    expect(await readFile(join(runDir, "executive", "output.md"), "utf-8")).toContain(
      "# Executive output"
    );
    expect(await readFile(join(runDir, "action", "output.md"), "utf-8")).toContain(
      "# Action output"
    );
  });
});
