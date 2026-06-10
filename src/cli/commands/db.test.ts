import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  MIGRATION_001,
  MIGRATION_002,
  MIGRATION_003,
  MIGRATION_004,
  MIGRATION_005,
  MIGRATION_006,
} from "../../storage/schema";
import { queryPrCounts, queryInactiveProjects } from "./db";

function buildTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version TEXT PRIMARY KEY,
      applied_at INTEGER DEFAULT (unixepoch())
    )
  `);

  db.exec(MIGRATION_001);
  db.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("001_init");
  db.exec(MIGRATION_002);
  db.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("002_add_active");
  db.exec(MIGRATION_003);
  db.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("003_budget_skipped");
  db.exec(MIGRATION_004);
  db.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("004_add_report_digest");
  db.exec(MIGRATION_005);
  db.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("005_add_subscription_fields");
  db.exec(MIGRATION_006);
  db.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("006_add_last_collected_at");

  return db;
}

describe("queryPrCounts and queryInactiveProjects", () => {
  it("PR counts include zero-PR active projects and inactive projects", () => {
    const db = buildTestDb();

    // project-A: active, has PRs in window (including one budget_skipped)
    db.query("INSERT INTO projects (id, org, repo, url, active) VALUES (?, ?, ?, ?, 1)").run(
      "org/project-a", "org", "project-a", "https://github.com/org/project-a"
    );
    // project-B: active, 0 PRs in window, has last_collected_at set
    const collectedAt = Math.floor(Date.now() / 1000) - 60;
    db.query("INSERT INTO projects (id, org, repo, url, active, last_collected_at) VALUES (?, ?, ?, ?, 1, ?)").run(
      "org/project-b", "org", "project-b", "https://github.com/org/project-b", collectedAt
    );
    // project-C: inactive
    db.query("INSERT INTO projects (id, org, repo, url, active, inactive_reason) VALUES (?, ?, ?, ?, 0, ?)").run(
      "org/project-c", "org", "project-c", "https://github.com/org/project-c", "repo_not_found"
    );

    // Daily window: unix range for "today"
    const windowStart = 1749340800; // 2026-06-08 00:00:00 UTC (arbitrary fixed window)
    const windowEnd = 1749427199;   // 2026-06-08 23:59:59 UTC

    // Insert PRs for project-A within the window
    db.query(
      "INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status) VALUES (?, ?, ?, ?, ?)"
    ).run("org/project-a", 1, "PR 1", windowStart + 100, "complete");
    db.query(
      "INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status) VALUES (?, ?, ?, ?, ?)"
    ).run("org/project-a", 2, "PR 2", windowStart + 200, "budget_skipped");
    db.query(
      "INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status) VALUES (?, ?, ?, ?, ?)"
    ).run("org/project-a", 3, "PR 3", windowStart + 300, "failed");

    const prCounts = queryPrCounts(db as unknown as ReturnType<typeof import("../../storage/db").getDb>, windowStart, windowEnd, "UTC");
    const inactiveProjects = queryInactiveProjects(db as unknown as ReturnType<typeof import("../../storage/db").getDb>);

    // Only active projects appear in prCounts
    const ids = prCounts.map((r) => r.project_id);
    expect(ids).toContain("org/project-a");
    expect(ids).toContain("org/project-b");
    expect(ids).not.toContain("org/project-c");

    // project-A has pr_count = analyzed + failed + pending + budget_skipped
    const rowA = prCounts.find((r) => r.project_id === "org/project-a")!;
    expect(rowA).toBeDefined();
    expect(rowA.pr_count).toBe(3);
    expect(rowA.analyzed).toBe(1);
    expect(rowA.failed).toBe(1);
    expect(rowA.budget_skipped).toBe(1);
    expect(rowA.pending).toBe(0);
    expect(rowA.pr_count).toBe(rowA.analyzed + rowA.failed + rowA.pending + rowA.budget_skipped);

    // project-B has pr_count = 0, last_collected_at populated, last_pr_at null
    const rowB = prCounts.find((r) => r.project_id === "org/project-b")!;
    expect(rowB).toBeDefined();
    expect(rowB.pr_count).toBe(0);
    expect(rowB.last_collected_at).toBe(collectedAt);
    expect(rowB.last_pr_at).toBeNull();

    // inactiveProjects contains project-C
    expect(inactiveProjects).toHaveLength(1);
    expect(inactiveProjects[0]!.id).toBe("org/project-c");
    expect(inactiveProjects[0]!.inactiveReason).toBe("repo_not_found");

    db.close();
  });

  it("display dates use resolved timezone, not UTC", () => {
    const db = buildTestDb();

    // 2026-06-09 23:59 UTC = 2026-06-10 07:59 Asia/Shanghai
    const collectedAtUtc = Math.floor(Date.UTC(2026, 5, 9, 23, 59) / 1000);

    db.query("INSERT INTO projects (id, org, repo, url, active, last_collected_at) VALUES (?, ?, ?, ?, 1, ?)").run(
      "org/project-b", "org", "project-b", "https://github.com/org/project-b", collectedAtUtc
    );

    const windowStart = 1749340800;
    const windowEnd = 1749427199;

    const prCounts = queryPrCounts(
      db as unknown as ReturnType<typeof import("../../storage/db").getDb>,
      windowStart,
      windowEnd,
      "Asia/Shanghai"
    );

    const rowB = prCounts.find((r) => r.project_id === "org/project-b")!;
    expect(rowB).toBeDefined();
    // In Asia/Shanghai this timestamp is 2026-06-10, not 2026-06-09
    expect(rowB.last_collected_date).toBe("2026-06-10");

    db.close();
  });
});
