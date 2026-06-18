import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDayPeriod } from "../utils/time-window";
import {
  getStartupBackfillRange,
  inspectStartupBackfillNeeds,
  runStartupBackfillIfNeeded,
} from "./backfill";

describe("getStartupBackfillRange", () => {
  it("defaults to the 7 most recent completed local days, ending yesterday", () => {
    const range = getStartupBackfillRange("Asia/Shanghai", new Date("2026-06-17T04:00:00Z"));
    expect(range).toEqual({ since: "2026-06-10", until: "2026-06-16" });
  });

  it("crosses the month boundary for the last7 range", () => {
    const range = getStartupBackfillRange("Asia/Shanghai", new Date("2026-06-03T04:00:00Z"));
    expect(range).toEqual({ since: "2026-05-27", until: "2026-06-02" });
  });

  it("returns local month start through yesterday in month mode", () => {
    const range = getStartupBackfillRange("Asia/Shanghai", new Date("2026-06-17T04:00:00Z"), "month");
    expect(range).toEqual({ since: "2026-06-01", until: "2026-06-16" });
  });

  it("returns the previous full month on the first local day of the month in month mode", () => {
    const range = getStartupBackfillRange("Asia/Shanghai", new Date("2026-06-01T04:00:00Z"), "month");
    expect(range).toEqual({ since: "2026-05-01", until: "2026-05-31" });
  });
});

let db: Database;

function applySchema(db: Database): void {
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      org TEXT NOT NULL,
      repo TEXT NOT NULL,
      url TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE pull_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      merged_at INTEGER,
      analysis_status TEXT DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0,
      UNIQUE(project_id, pr_number)
    );
    CREATE TABLE reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      content TEXT NOT NULL,
      digest_json TEXT,
      UNIQUE(type, period_start, period_end)
    );
  `);
}

const PROJECTS = [{ org: "org", repo: "repo", url: "https://github.com/org/repo" }];
const silentLog = { info: (_message: string) => {}, warn: (_message: string) => {}, error: (_message: string) => {} };

describe("inspectStartupBackfillNeeds", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => db.close());

  it("requires backfill when a configured repo is missing from SQLite", () => {
    const result = inspectStartupBackfillNeeds(db, PROJECTS, {
      timezone: "UTC",
      since: "2026-06-01",
      until: "2026-06-01",
    });
    expect(result.needed).toBe(true);
    expect(result.reasons).toContain("missing_repo:org/repo");
  });

  it("requires backfill when a daily digest is missing", () => {
    db.run(
      "INSERT INTO projects (id, org, repo, url, active) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo', 1)"
    );
    const result = inspectStartupBackfillNeeds(db, PROJECTS, {
      timezone: "UTC",
      since: "2026-06-01",
      until: "2026-06-01",
    });
    expect(result.needed).toBe(true);
    expect(result.reasons).toContain("missing_digest:2026-06-01");
  });

  it("requires backfill when a daily digest is null", () => {
    db.run(
      "INSERT INTO projects (id, org, repo, url, active) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo', 1)"
    );
    const { startUnix, endUnix } = getDayPeriod("UTC", "2026-06-01");
    db.run(
      "INSERT INTO reports (type, period_start, period_end, content, digest_json) VALUES ('daily', ?, ?, 'null', NULL)",
      [startUnix, endUnix]
    );

    const result = inspectStartupBackfillNeeds(db, PROJECTS, {
      timezone: "UTC",
      since: "2026-06-01",
      until: "2026-06-01",
    });
    expect(result.needed).toBe(true);
    expect(result.reasons).toContain("null_digest:2026-06-01");
  });

  it("requires backfill when PR analysis is incomplete in range", () => {
    db.run(
      "INSERT INTO projects (id, org, repo, url, active) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo', 1)"
    );
    const { startUnix, endUnix } = getDayPeriod("UTC", "2026-06-01");
    db.run(
      "INSERT INTO reports (type, period_start, period_end, content, digest_json) VALUES ('daily', ?, ?, 'null', '{}')",
      [startUnix, endUnix]
    );
    db.run(
      "INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status) VALUES ('org/repo', 1, 'Pending', ?, 'pending')",
      [startUnix + 3600]
    );

    const result = inspectStartupBackfillNeeds(db, PROJECTS, {
      timezone: "UTC",
      since: "2026-06-01",
      until: "2026-06-01",
    });
    expect(result.needed).toBe(true);
    expect(result.reasons).toContain("incomplete_prs:2026-06-01:1");
  });

  it("does not require backfill for terminal failed and budget-skipped PRs with a null digest", () => {
    db.run(
      "INSERT INTO projects (id, org, repo, url, active) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo', 1)"
    );
    const { startUnix, endUnix } = getDayPeriod("UTC", "2026-06-01");
    db.run(
      "INSERT INTO reports (type, period_start, period_end, content, digest_json) VALUES ('daily', ?, ?, 'null', NULL)",
      [startUnix, endUnix]
    );
    db.run(
      "INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status, retry_count) VALUES ('org/repo', 1, 'Exhausted', ?, 'failed', 3)",
      [startUnix + 3600]
    );
    db.run(
      "INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status) VALUES ('org/repo', 2, 'Budget skipped', ?, 'budget_skipped')",
      [startUnix + 7200]
    );

    const result = inspectStartupBackfillNeeds(db, PROJECTS, {
      timezone: "UTC",
      since: "2026-06-01",
      until: "2026-06-01",
    });
    expect(result).toEqual({ needed: false, reasons: [] });
  });

  it("does not require backfill when a null digest is only blocked by terminal PRs", () => {
    db.run(
      "INSERT INTO projects (id, org, repo, url, active) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo', 1)"
    );
    const { startUnix, endUnix } = getDayPeriod("UTC", "2026-06-01");
    db.run(
      "INSERT INTO reports (type, period_start, period_end, content, digest_json) VALUES ('daily', ?, ?, 'null', NULL)",
      [startUnix, endUnix]
    );
    db.run(
      "INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status) VALUES ('org/repo', 1, 'Done', ?, 'complete')",
      [startUnix + 1800]
    );
    db.run(
      "INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status, retry_count) VALUES ('org/repo', 2, 'Exhausted', ?, 'failed', 3)",
      [startUnix + 3600]
    );

    const result = inspectStartupBackfillNeeds(db, PROJECTS, {
      timezone: "UTC",
      since: "2026-06-01",
      until: "2026-06-01",
    });
    expect(result).toEqual({ needed: false, reasons: [] });
  });

  it("does not require backfill for a missing digest that automatic backfill cannot complete", () => {
    db.run(
      "INSERT INTO projects (id, org, repo, url, active) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo', 1)"
    );
    const { startUnix } = getDayPeriod("UTC", "2026-06-01");
    db.run(
      "INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status, retry_count) VALUES ('org/repo', 1, 'Exhausted', ?, 'failed', 3)",
      [startUnix + 3600]
    );

    const result = inspectStartupBackfillNeeds(db, PROJECTS, {
      timezone: "UTC",
      since: "2026-06-01",
      until: "2026-06-01",
    });
    expect(result).toEqual({ needed: false, reasons: [] });
  });

  it("ignores incomplete PRs from repositories that are no longer active", () => {
    db.run(
      "INSERT INTO projects (id, org, repo, url, active) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo', 1)"
    );
    db.run(
      "INSERT INTO projects (id, org, repo, url, active) VALUES ('old/repo', 'old', 'repo', 'https://github.com/old/repo', 0)"
    );
    const { startUnix, endUnix } = getDayPeriod("UTC", "2026-06-01");
    db.run(
      "INSERT INTO reports (type, period_start, period_end, content, digest_json) VALUES ('daily', ?, ?, 'null', '{}')",
      [startUnix, endUnix]
    );
    db.run(
      "INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status) VALUES ('old/repo', 1, 'Old pending', ?, 'pending')",
      [startUnix + 3600]
    );

    const result = inspectStartupBackfillNeeds(db, PROJECTS, {
      timezone: "UTC",
      since: "2026-06-01",
      until: "2026-06-01",
    });
    expect(result).toEqual({ needed: false, reasons: [] });
  });

  it("skips backfill when repos, digests, and PR analyses are complete", () => {
    db.run(
      "INSERT INTO projects (id, org, repo, url, active) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo', 1)"
    );
    const { startUnix, endUnix } = getDayPeriod("UTC", "2026-06-01");
    db.run(
      "INSERT INTO reports (type, period_start, period_end, content, digest_json) VALUES ('daily', ?, ?, 'null', '{}')",
      [startUnix, endUnix]
    );
    db.run(
      "INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status) VALUES ('org/repo', 1, 'Done', ?, 'complete')",
      [startUnix + 3600]
    );

    const result = inspectStartupBackfillNeeds(db, PROJECTS, {
      timezone: "UTC",
      since: "2026-06-01",
      until: "2026-06-01",
    });
    expect(result).toEqual({ needed: false, reasons: [] });
  });
});

describe("runStartupBackfillIfNeeded", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => db.close());

  it("runs backfill for the last7 range by default when inspection finds gaps", async () => {
    const calls: Array<{ since: string; until: string; allowPartial: boolean; resetAnalysisStatus: boolean | undefined }> = [];

    await runStartupBackfillIfNeeded({
      enabled: true,
      now: new Date("2026-06-17T04:00:00Z"),
      timezone: "Asia/Shanghai",
      db,
      getTrackedProjects: () => PROJECTS,
      log: silentLog,
      runBackfill: async (since, until, allowPartial, options) => {
        calls.push({ since, until, allowPartial, resetAnalysisStatus: options.resetAnalysisStatus });
        return { days: [], anySkipped: false };
      },
    });

    expect(calls).toEqual([
      { since: "2026-06-10", until: "2026-06-16", allowPartial: false, resetAnalysisStatus: false },
    ]);
  });

  it("runs backfill for the current month-to-date range in month mode", async () => {
    const calls: Array<{ since: string; until: string }> = [];

    await runStartupBackfillIfNeeded({
      enabled: true,
      rangeMode: "month",
      now: new Date("2026-06-17T04:00:00Z"),
      timezone: "Asia/Shanghai",
      db,
      getTrackedProjects: () => PROJECTS,
      log: silentLog,
      runBackfill: async (since, until) => {
        calls.push({ since, until });
        return { days: [], anySkipped: false };
      },
    });

    expect(calls).toEqual([{ since: "2026-06-01", until: "2026-06-16" }]);
  });

  it("does not run backfill when startup backfill is disabled", async () => {
    let called = false;
    await runStartupBackfillIfNeeded({
      enabled: false,
      now: new Date("2026-06-17T04:00:00Z"),
      timezone: "Asia/Shanghai",
      db,
      getTrackedProjects: () => PROJECTS,
      log: silentLog,
      runBackfill: async () => {
        called = true;
        return { days: [], anySkipped: false };
      },
    });

    expect(called).toBe(false);
  });

  it("does not run backfill when inspection is complete", async () => {
    db.run(
      "INSERT INTO projects (id, org, repo, url, active) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo', 1)"
    );
    for (const day of ["2026-06-01", "2026-06-02"]) {
      const { startUnix, endUnix } = getDayPeriod("UTC", day);
      db.run(
        "INSERT INTO reports (type, period_start, period_end, content, digest_json) VALUES ('daily', ?, ?, 'null', '{}')",
        [startUnix, endUnix]
      );
    }

    let called = false;
    await runStartupBackfillIfNeeded({
      enabled: true,
      rangeMode: "month",
      now: new Date("2026-06-03T12:00:00Z"),
      timezone: "UTC",
      db,
      getTrackedProjects: () => PROJECTS,
      log: silentLog,
      runBackfill: async () => {
        called = true;
        return { days: [], anySkipped: false };
      },
    });

    expect(called).toBe(false);
  });

  it("swallows backfill errors so startup can continue", async () => {
    const errors: string[] = [];

    await expect(
      runStartupBackfillIfNeeded({
        enabled: true,
        now: new Date("2026-06-17T04:00:00Z"),
        timezone: "Asia/Shanghai",
        db,
        getTrackedProjects: () => PROJECTS,
        runBackfill: async () => {
          throw new Error("temporary GitHub failure");
        },
        log: {
          info: () => {},
          warn: (message) => errors.push(String(message)),
          error: (message) => errors.push(String(message)),
        },
      })
    ).resolves.toBeUndefined();
    expect(errors.some((line) => line.includes("temporary GitHub failure"))).toBe(true);
  });
});
