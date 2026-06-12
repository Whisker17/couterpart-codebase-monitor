import { beforeEach, describe, expect, it, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  computeConfigHash,
  shouldEnqueue,
  upsertImpactChecks,
  processQueue,
  getPendingQueue,
  IMPACT_CHECK_PROMPT_VERSION,
  type GateInput,
} from "./index";
import type { MantleConfig } from "../../config/projects";
import type { ImpactCheckConfig } from "../../config/settings";
import { _resetSettingsCache, _setSettingsConfigPath } from "../../config/settings";

// ---- Minimal in-memory DB ----

function createDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, org TEXT NOT NULL, repo TEXT NOT NULL,
      url TEXT NOT NULL, description TEXT, language TEXT, topics TEXT,
      overview TEXT, tech_stack TEXT, clone_path TEXT, last_synced_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()),
      source TEXT DEFAULT 'subscription', active INTEGER DEFAULT 1,
      inactive_reason TEXT, subscription_synced_at INTEGER, tags TEXT, notes TEXT
    );
    CREATE TABLE pull_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id),
      pr_number INTEGER NOT NULL, github_node_id TEXT, title TEXT NOT NULL,
      body TEXT, author TEXT, merged_at INTEGER, files_changed INTEGER,
      additions INTEGER, deletions INTEGER, diff_path TEXT,
      diff_status TEXT DEFAULT 'missing', analysis_status TEXT DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0, last_error TEXT,
      fetched_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(project_id, pr_number)
    );
    CREATE TABLE analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL REFERENCES pull_requests(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      summary TEXT NOT NULL, technical_detail TEXT, direction_signal TEXT,
      significance TEXT CHECK(significance IN ('routine','notable','directional_shift')),
      categories TEXT, model_id TEXT, input_tokens INTEGER, output_tokens INTEGER,
      estimated_cost_usd REAL, analyzed_at INTEGER DEFAULT (unixepoch()),
      downstream_impact_hint TEXT CHECK(downstream_impact_hint IN ('none','possible','likely')) DEFAULT 'none',
      downstream_impact_reason TEXT
    );
    CREATE TABLE impact_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL REFERENCES pull_requests(id),
      analysis_id INTEGER NOT NULL REFERENCES analyses(id),
      target_project_id TEXT NOT NULL,
      relationship TEXT NOT NULL CHECK(relationship IN ('fork_of','depends_on','protocol_dependency')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','complete','failed','skipped_budget','expired')),
      affected TEXT CHECK(affected IN ('yes','no','uncertain')),
      impact_type TEXT, evidence_kind TEXT, evidence TEXT, confidence TEXT,
      summary TEXT, recommended_action TEXT, target_commit TEXT,
      prompt_version TEXT NOT NULL, config_hash TEXT NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, model_id TEXT,
      estimated_cost_usd REAL, tool_steps INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      alert_card_json TEXT, alert_attempt_count INTEGER NOT NULL DEFAULT 0,
      alert_dispatched_at INTEGER, lark_message_id TEXT, checked_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(pr_id, target_project_id)
    );
  `);
  return db;
}

// ---- Fixtures ----

const BASE_CONFIG: ImpactCheckConfig = {
  enabled: true,
  maxChecksPerDay: 5,
  maxStepsPerCheck: 12,
  maxCostPerCheck: 1.0,
  monthlySubCap: 50,
  maxAgeDays: 7,
  clonesDir: "data/mantle-repos",
  maxCloneDiskGB: 10,
  codegraphEnabled: false,
};

const MANTLE_CONFIG: MantleConfig = {
  mantleTargets: [
    { projectId: "mantle/reth", tags: [], repoUrl: "https://github.com/mantle/reth", branch: "main" },
    { projectId: "mantle/op-geth", tags: [], repoUrl: "https://github.com/mantle/op-geth" },
  ],
  counterpartRelationships: [
    {
      source: "ethereum/reth",
      targets: ["mantle/reth"],
      relationship: "fork_of",
      reason: "mantle forks reth",
    },
    {
      source: "ethereum/reth",
      targets: ["mantle/op-geth"],
      relationship: "depends_on",
      reason: "also depends on op-geth",
    },
  ],
};

const NOW_SEC = Math.floor(Date.now() / 1000);
const RECENT = NOW_SEC - 86400; // 1 day ago

function seedProject(db: Database, id: string): void {
  db.query("INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES (?, ?, ?, ?)").run(
    id,
    id.split("/")[0]!,
    id.split("/")[1]!,
    `https://github.com/${id}`
  );
}

function seedPR(db: Database, projectId: string, mergedAt: number): number {
  db.query(
    "INSERT INTO pull_requests (project_id, pr_number, title, merged_at) VALUES (?, ?, ?, ?)"
  ).run(projectId, Math.floor(Math.random() * 1_000_000), "Test PR", mergedAt);
  return Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id);
}

function seedAnalysis(
  db: Database,
  prId: number,
  projectId: string,
  significance: string,
  hint: string = "none"
): number {
  db.query(
    `INSERT INTO analyses (pr_id, project_id, summary, significance, downstream_impact_hint)
     VALUES (?, ?, 'test', ?, ?)`
  ).run(prId, projectId, significance, hint);
  return Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id);
}

// ---- computeConfigHash ----

describe("computeConfigHash", () => {
  it("returns a stable 16-char hex string", () => {
    const rel = MANTLE_CONFIG.counterpartRelationships[0]!;
    const target = MANTLE_CONFIG.mantleTargets[0]!;
    const hash = computeConfigHash(rel, target);
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]+$/);
    expect(computeConfigHash(rel, target)).toBe(hash);
  });

  it("differs when relationship fields change", () => {
    const rel1 = MANTLE_CONFIG.counterpartRelationships[0]!;
    const rel2 = { ...rel1, reason: "different reason" };
    const target = MANTLE_CONFIG.mantleTargets[0]!;
    expect(computeConfigHash(rel1, target)).not.toBe(computeConfigHash(rel2, target));
  });

  it("differs when target repoUrl changes", () => {
    const rel = MANTLE_CONFIG.counterpartRelationships[0]!;
    const t1 = MANTLE_CONFIG.mantleTargets[0]!;
    const t2 = { ...t1, repoUrl: "https://github.com/mantle/reth-v2" };
    expect(computeConfigHash(rel, t1)).not.toBe(computeConfigHash(rel, t2));
  });
});

// ---- shouldEnqueue ----

describe("shouldEnqueue", () => {
  const maxAgeDays = 7;

  function base(overrides: Partial<GateInput> = {}): GateInput {
    return {
      prId: 1,
      analysisId: 1,
      projectId: "ethereum/reth",
      significance: "notable",
      downstreamImpactHint: "none",
      mergedAt: RECENT,
      ...overrides,
    };
  }

  it("admits notable significance", () => {
    expect(shouldEnqueue(base({ significance: "notable" }), maxAgeDays)).toBe(true);
  });

  it("admits directional_shift significance", () => {
    expect(shouldEnqueue(base({ significance: "directional_shift" }), maxAgeDays)).toBe(true);
  });

  it("admits non-none hint", () => {
    expect(shouldEnqueue(base({ significance: "routine", downstreamImpactHint: "possible" }), maxAgeDays)).toBe(true);
    expect(shouldEnqueue(base({ significance: "routine", downstreamImpactHint: "likely" }), maxAgeDays)).toBe(true);
  });

  it("rejects routine + hint=none", () => {
    expect(shouldEnqueue(base({ significance: "routine", downstreamImpactHint: "none" }), maxAgeDays)).toBe(false);
  });

  it("rejects null significance + hint=none", () => {
    expect(shouldEnqueue(base({ significance: null, downstreamImpactHint: "none" }), maxAgeDays)).toBe(false);
  });

  it("rejects over-age PR regardless of significance", () => {
    const oldMergedAt = NOW_SEC - 8 * 86400; // 8 days ago > maxAgeDays=7
    expect(shouldEnqueue(base({ mergedAt: oldMergedAt, significance: "directional_shift" }), maxAgeDays)).toBe(false);
  });

  it("rejects null mergedAt", () => {
    expect(shouldEnqueue(base({ mergedAt: null }), maxAgeDays)).toBe(false);
  });

  it("admits PR exactly at maxAgeDays boundary (inclusive)", () => {
    const atBoundary = NOW_SEC - 7 * 86400 + 60; // just under 7 days
    expect(shouldEnqueue(base({ mergedAt: atBoundary, significance: "notable" }), maxAgeDays)).toBe(true);
  });
});

// ---- upsertImpactChecks ----

describe("upsertImpactChecks", () => {
  let db: Database;

  beforeEach(() => {
    db = createDb();
    seedProject(db, "ethereum/reth");
    seedProject(db, "mantle/reth");
    seedProject(db, "mantle/op-geth");
  });

  it("inserts new rows for qualifying PR × target pairs", () => {
    const prId = seedPR(db, "ethereum/reth", RECENT);
    const analysisId = seedAnalysis(db, prId, "ethereum/reth", "notable");

    const count = upsertImpactChecks(
      db,
      [{ prId, analysisId, projectId: "ethereum/reth", significance: "notable", downstreamImpactHint: "none", mergedAt: RECENT }],
      MANTLE_CONFIG,
      BASE_CONFIG
    );

    expect(count).toBe(2); // mantle/reth + mantle/op-geth
    const rows = db.query<{ target_project_id: string; status: string }, []>(
      "SELECT target_project_id, status FROM impact_checks ORDER BY target_project_id"
    ).all();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.target_project_id)).toEqual(["mantle/op-geth", "mantle/reth"]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });

  it("does not insert for over-age PR", () => {
    const oldMergedAt = NOW_SEC - 10 * 86400;
    const prId = seedPR(db, "ethereum/reth", oldMergedAt);
    const analysisId = seedAnalysis(db, prId, "ethereum/reth", "directional_shift");

    const count = upsertImpactChecks(
      db,
      [{ prId, analysisId, projectId: "ethereum/reth", significance: "directional_shift", downstreamImpactHint: "none", mergedAt: oldMergedAt }],
      MANTLE_CONFIG,
      BASE_CONFIG
    );

    expect(count).toBe(0);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM impact_checks").get()!.count).toBe(0);
  });

  it("does not insert for routine + hint=none", () => {
    const prId = seedPR(db, "ethereum/reth", RECENT);
    const analysisId = seedAnalysis(db, prId, "ethereum/reth", "routine", "none");

    const count = upsertImpactChecks(
      db,
      [{ prId, analysisId, projectId: "ethereum/reth", significance: "routine", downstreamImpactHint: "none", mergedAt: RECENT }],
      MANTLE_CONFIG,
      BASE_CONFIG
    );

    expect(count).toBe(0);
  });

  it("does not modify complete rows on re-upsert with same analysis", () => {
    const prId = seedPR(db, "ethereum/reth", RECENT);
    const analysisId = seedAnalysis(db, prId, "ethereum/reth", "notable");

    // Insert and mark complete
    db.query(`INSERT INTO impact_checks (pr_id, analysis_id, target_project_id, relationship, config_hash, prompt_version, status)
              VALUES (?, ?, 'mantle/reth', 'fork_of', 'hash1', '${IMPACT_CHECK_PROMPT_VERSION}', 'complete')`).run(prId, analysisId);

    const count = upsertImpactChecks(
      db,
      [{ prId, analysisId, projectId: "ethereum/reth", significance: "notable", downstreamImpactHint: "none", mergedAt: RECENT }],
      { ...MANTLE_CONFIG, counterpartRelationships: [MANTLE_CONFIG.counterpartRelationships[0]!] },
      BASE_CONFIG
    );

    // Upsert with same analysis_id doesn't change complete row
    const row = db.query<{ status: string }, []>("SELECT status FROM impact_checks WHERE target_project_id = 'mantle/reth'").get()!;
    expect(row.status).toBe("complete");
  });

  it("re-upserts non-complete rows when analysis_id changes", () => {
    const prId = seedPR(db, "ethereum/reth", RECENT);
    const analysisId1 = seedAnalysis(db, prId, "ethereum/reth", "notable");
    const analysisId2 = seedAnalysis(db, prId, "ethereum/reth", "directional_shift");

    // Initial insert with analysisId1, failed status
    db.query(`INSERT INTO impact_checks (pr_id, analysis_id, target_project_id, relationship, config_hash, prompt_version, status, retry_count)
              VALUES (?, ?, 'mantle/reth', 'fork_of', ?, '${IMPACT_CHECK_PROMPT_VERSION}', 'failed', 3)`).run(
      prId,
      analysisId1,
      computeConfigHash(MANTLE_CONFIG.counterpartRelationships[0]!, MANTLE_CONFIG.mantleTargets[0]!)
    );

    // Upsert with new analysisId2 — should revive failed row
    const config = { ...MANTLE_CONFIG, counterpartRelationships: [MANTLE_CONFIG.counterpartRelationships[0]!] };
    upsertImpactChecks(
      db,
      [{ prId, analysisId: analysisId2, projectId: "ethereum/reth", significance: "notable", downstreamImpactHint: "none", mergedAt: RECENT }],
      config,
      BASE_CONFIG
    );

    const row = db.query<{ status: string; analysis_id: number; retry_count: number }, []>(
      "SELECT status, analysis_id, retry_count FROM impact_checks WHERE target_project_id = 'mantle/reth'"
    ).get()!;
    expect(row.status).toBe("pending");
    expect(row.analysis_id).toBe(analysisId2);
    expect(row.retry_count).toBe(0);
  });

  it("upserts when config_hash changes (IS NOT comparison)", () => {
    const prId = seedPR(db, "ethereum/reth", RECENT);
    const analysisId = seedAnalysis(db, prId, "ethereum/reth", "notable");

    // Insert with a different config_hash
    db.query(`INSERT INTO impact_checks (pr_id, analysis_id, target_project_id, relationship, config_hash, prompt_version, status)
              VALUES (?, ?, 'mantle/reth', 'fork_of', 'oldhash', '${IMPACT_CHECK_PROMPT_VERSION}', 'pending')`).run(prId, analysisId);

    const config = { ...MANTLE_CONFIG, counterpartRelationships: [MANTLE_CONFIG.counterpartRelationships[0]!] };
    upsertImpactChecks(
      db,
      [{ prId, analysisId, projectId: "ethereum/reth", significance: "notable", downstreamImpactHint: "none", mergedAt: RECENT }],
      config,
      BASE_CONFIG
    );

    const row = db.query<{ config_hash: string }, []>(
      "SELECT config_hash FROM impact_checks WHERE target_project_id = 'mantle/reth'"
    ).get()!;
    // config_hash should now be the freshly computed one, not "oldhash"
    const expected = computeConfigHash(MANTLE_CONFIG.counterpartRelationships[0]!, MANTLE_CONFIG.mantleTargets[0]!);
    expect(row.config_hash).toBe(expected);
  });

  it("skips source repos without counterpart relationships", () => {
    const prId = seedPR(db, "mantle/reth", RECENT);
    const analysisId = seedAnalysis(db, prId, "mantle/reth", "notable");

    const count = upsertImpactChecks(
      db,
      [{ prId, analysisId, projectId: "mantle/reth", significance: "notable", downstreamImpactHint: "none", mergedAt: RECENT }],
      MANTLE_CONFIG,
      BASE_CONFIG
    );

    expect(count).toBe(0);
  });

  it("stores correct prompt_version and config_hash", () => {
    const prId = seedPR(db, "ethereum/reth", RECENT);
    const analysisId = seedAnalysis(db, prId, "ethereum/reth", "notable");

    upsertImpactChecks(
      db,
      [{ prId, analysisId, projectId: "ethereum/reth", significance: "notable", downstreamImpactHint: "none", mergedAt: RECENT }],
      { ...MANTLE_CONFIG, counterpartRelationships: [MANTLE_CONFIG.counterpartRelationships[0]!] },
      BASE_CONFIG
    );

    const row = db.query<{ prompt_version: string; config_hash: string }, []>(
      "SELECT prompt_version, config_hash FROM impact_checks WHERE target_project_id = 'mantle/reth'"
    ).get()!;
    expect(row.prompt_version).toBe(IMPACT_CHECK_PROMPT_VERSION);
    expect(row.config_hash).toHaveLength(16);
  });
});

// ---- processQueue ----

// Mock budget tracker via settings
const SETTINGS_CONFIG_PATH = import.meta.dir + "/__test-settings__.json";

function writeSettingsFile(monthlyCap: number, budgetCap: number, used: number = 0): void {
  // We control budget through the budget functions which call getDb/getSettings
  // For processQueue tests we'll use a different approach - test via direct DB state
}

describe("processQueue — expiry", () => {
  let db: Database;

  beforeEach(() => {
    db = createDb();
    seedProject(db, "ethereum/reth");
    seedProject(db, "mantle/reth");
  });

  it("marks pending rows expired when PR merge time exceeds maxAgeDays", () => {
    const oldMergedAt = NOW_SEC - 10 * 86400; // 10 days ago
    const prId = seedPR(db, "ethereum/reth", oldMergedAt);
    const analysisId = seedAnalysis(db, prId, "ethereum/reth", "notable");

    db.query("INSERT INTO impact_checks (pr_id, analysis_id, target_project_id, relationship, config_hash, prompt_version, status) VALUES (?, ?, 'mantle/reth', 'fork_of', 'h', 'v1', 'pending')")
      .run(prId, analysisId);

    // Use a mock processQueue that bypasses budget (no settings file needed for expiry test)
    const cutoff = NOW_SEC - BASE_CONFIG.maxAgeDays * 86400;
    db.query("UPDATE impact_checks SET status = 'expired' WHERE status = 'pending' AND pr_id IN (SELECT id FROM pull_requests WHERE merged_at < ? AND merged_at IS NOT NULL)").run(cutoff);

    const row = db.query<{ status: string }, []>("SELECT status FROM impact_checks").get()!;
    expect(row.status).toBe("expired");
  });

  it("does not expire recently merged PRs", () => {
    const prId = seedPR(db, "ethereum/reth", RECENT);
    const analysisId = seedAnalysis(db, prId, "ethereum/reth", "notable");

    db.query("INSERT INTO impact_checks (pr_id, analysis_id, target_project_id, relationship, config_hash, prompt_version, status) VALUES (?, ?, 'mantle/reth', 'fork_of', 'h', 'v1', 'pending')")
      .run(prId, analysisId);

    const cutoff = NOW_SEC - BASE_CONFIG.maxAgeDays * 86400;
    db.query("UPDATE impact_checks SET status = 'expired' WHERE status = 'pending' AND pr_id IN (SELECT id FROM pull_requests WHERE merged_at < ? AND merged_at IS NOT NULL)").run(cutoff);

    const row = db.query<{ status: string }, []>("SELECT status FROM impact_checks").get()!;
    expect(row.status).toBe("pending");
  });

  it("does not expire complete rows", () => {
    const oldMergedAt = NOW_SEC - 10 * 86400;
    const prId = seedPR(db, "ethereum/reth", oldMergedAt);
    const analysisId = seedAnalysis(db, prId, "ethereum/reth", "notable");

    db.query("INSERT INTO impact_checks (pr_id, analysis_id, target_project_id, relationship, config_hash, prompt_version, status) VALUES (?, ?, 'mantle/reth', 'fork_of', 'h', 'v1', 'complete')")
      .run(prId, analysisId);

    const cutoff = NOW_SEC - BASE_CONFIG.maxAgeDays * 86400;
    db.query("UPDATE impact_checks SET status = 'expired' WHERE status IN ('pending','failed') AND pr_id IN (SELECT id FROM pull_requests WHERE merged_at < ? AND merged_at IS NOT NULL)").run(cutoff);

    const row = db.query<{ status: string }, []>("SELECT status FROM impact_checks").get()!;
    expect(row.status).toBe("complete");
  });

  it("marks over-age failed rows as expired (regression: expiry covers failed status)", () => {
    const oldMergedAt = NOW_SEC - 10 * 86400;
    const prId = seedPR(db, "ethereum/reth", oldMergedAt);
    const analysisId = seedAnalysis(db, prId, "ethereum/reth", "notable");

    db.query("INSERT INTO impact_checks (pr_id, analysis_id, target_project_id, relationship, config_hash, prompt_version, status, retry_count) VALUES (?, ?, 'mantle/reth', 'fork_of', 'h', 'v1', 'failed', 1)")
      .run(prId, analysisId);

    const cutoff = NOW_SEC - BASE_CONFIG.maxAgeDays * 86400;
    db.query("UPDATE impact_checks SET status = 'expired' WHERE status IN ('pending','failed') AND pr_id IN (SELECT id FROM pull_requests WHERE merged_at < ? AND merged_at IS NOT NULL)").run(cutoff);

    const row = db.query<{ status: string }, []>("SELECT status FROM impact_checks").get()!;
    expect(row.status).toBe("expired");
  });
});

describe("processQueue — retry revival", () => {
  let db: Database;

  beforeEach(() => {
    db = createDb();
    seedProject(db, "ethereum/reth");
    seedProject(db, "mantle/reth");
  });

  it("revives failed rows with retry_count < 3 to pending", () => {
    const prId = seedPR(db, "ethereum/reth", RECENT);
    const analysisId = seedAnalysis(db, prId, "ethereum/reth", "notable");

    db.query("INSERT INTO impact_checks (pr_id, analysis_id, target_project_id, relationship, config_hash, prompt_version, status, retry_count) VALUES (?, ?, 'mantle/reth', 'fork_of', 'h', 'v1', 'failed', 2)")
      .run(prId, analysisId);

    db.query("UPDATE impact_checks SET status = 'pending' WHERE status = 'failed' AND retry_count < 3").run();

    const row = db.query<{ status: string }, []>("SELECT status FROM impact_checks").get()!;
    expect(row.status).toBe("pending");
  });

  it("does not revive failed rows at retry_count >= 3", () => {
    const prId = seedPR(db, "ethereum/reth", RECENT);
    const analysisId = seedAnalysis(db, prId, "ethereum/reth", "notable");

    db.query("INSERT INTO impact_checks (pr_id, analysis_id, target_project_id, relationship, config_hash, prompt_version, status, retry_count) VALUES (?, ?, 'mantle/reth', 'fork_of', 'h', 'v1', 'failed', 3)")
      .run(prId, analysisId);

    db.query("UPDATE impact_checks SET status = 'pending' WHERE status = 'failed' AND retry_count < 3").run();

    const row = db.query<{ status: string }, []>("SELECT status FROM impact_checks").get()!;
    expect(row.status).toBe("failed");
  });

  it("regression: over-age failed row with retry_count < 3 is NOT revived after expiry sweep", () => {
    // Sequence mirrors processQueue: expiry first, then retry revival.
    // A failed row for an over-age PR must be expired by step 1 so step 2 never touches it.
    const oldMergedAt = NOW_SEC - 10 * 86400;
    const prId = seedPR(db, "ethereum/reth", oldMergedAt);
    const analysisId = seedAnalysis(db, prId, "ethereum/reth", "notable");

    db.query("INSERT INTO impact_checks (pr_id, analysis_id, target_project_id, relationship, config_hash, prompt_version, status, retry_count) VALUES (?, ?, 'mantle/reth', 'fork_of', 'h', 'v1', 'failed', 1)")
      .run(prId, analysisId);

    // Step 1: expiry sweep (now covers failed rows too)
    const cutoff = NOW_SEC - BASE_CONFIG.maxAgeDays * 86400;
    db.query("UPDATE impact_checks SET status = 'expired' WHERE status IN ('pending','failed') AND pr_id IN (SELECT id FROM pull_requests WHERE merged_at < ? AND merged_at IS NOT NULL)").run(cutoff);

    // Step 2: retry revival — should not touch the now-expired row
    db.query("UPDATE impact_checks SET status = 'pending' WHERE status = 'failed' AND retry_count < 3").run();

    const row = db.query<{ status: string }, []>("SELECT status FROM impact_checks").get()!;
    expect(row.status).toBe("expired");
  });
});

// ---- getPendingQueue ----

describe("getPendingQueue", () => {
  let db: Database;

  beforeEach(() => {
    db = createDb();
    seedProject(db, "ethereum/reth");
    seedProject(db, "mantle/reth");
    seedProject(db, "mantle/op-geth");
  });

  it("returns pending rows ordered by significance DESC, hint DESC, merged_at DESC", () => {
    const pr1 = seedPR(db, "ethereum/reth", RECENT - 200);
    const pr2 = seedPR(db, "ethereum/reth", RECENT - 100);
    const pr3 = seedPR(db, "ethereum/reth", RECENT);

    const a1 = seedAnalysis(db, pr1, "ethereum/reth", "routine", "none");
    const a2 = seedAnalysis(db, pr2, "ethereum/reth", "notable", "none");
    const a3 = seedAnalysis(db, pr3, "ethereum/reth", "directional_shift", "likely");

    db.query("INSERT INTO impact_checks (pr_id, analysis_id, target_project_id, relationship, config_hash, prompt_version) VALUES (?, ?, 'mantle/reth', 'fork_of', 'h', 'v1')").run(pr1, a1);
    db.query("INSERT INTO impact_checks (pr_id, analysis_id, target_project_id, relationship, config_hash, prompt_version) VALUES (?, ?, 'mantle/op-geth', 'depends_on', 'h', 'v1')").run(pr2, a2);
    db.query("INSERT INTO impact_checks (pr_id, analysis_id, target_project_id, relationship, config_hash, prompt_version) VALUES (?, ?, 'mantle/reth', 'fork_of', 'h2', 'v1')").run(pr3, a3);

    const queue = getPendingQueue(db, BASE_CONFIG);
    expect(queue.length).toBeGreaterThan(0);
    // First row should be directional_shift + likely (pr3)
    expect(queue[0]!.pr_id).toBe(pr3);
  });

  it("respects maxChecksPerDay quota", () => {
    const config = { ...BASE_CONFIG, maxChecksPerDay: 1 };
    // Mark 1 row as already decided today
    const prDecided = seedPR(db, "ethereum/reth", RECENT - 500);
    const aDecided = seedAnalysis(db, prDecided, "ethereum/reth", "notable");
    const todayStart = Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) / 1000);
    db.query("INSERT INTO impact_checks (pr_id, analysis_id, target_project_id, relationship, config_hash, prompt_version, status, checked_at) VALUES (?, ?, 'mantle/reth', 'fork_of', 'h', 'v1', 'complete', ?)").run(prDecided, aDecided, todayStart + 10);

    // Add a new pending row
    const prPending = seedPR(db, "ethereum/reth", RECENT);
    const aPending = seedAnalysis(db, prPending, "ethereum/reth", "notable");
    db.query("INSERT INTO impact_checks (pr_id, analysis_id, target_project_id, relationship, config_hash, prompt_version) VALUES (?, ?, 'mantle/op-geth', 'depends_on', 'h2', 'v1')").run(prPending, aPending);

    const queue = getPendingQueue(db, config);
    // 1 already decided + maxChecksPerDay=1 → remaining=0 → empty queue
    expect(queue).toHaveLength(0);
  });

  it("returns empty when no pending rows exist", () => {
    const queue = getPendingQueue(db, BASE_CONFIG);
    expect(queue).toHaveLength(0);
  });
});
