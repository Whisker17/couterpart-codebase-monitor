import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stage, execute } from "./impact-check";
import type { ImpactCheckStageDeps } from "./impact-check";
import { getRunStages, getE2EStages } from "../../e2e-run";
import { getSettings, _resetSettingsCache, _setSettingsConfigPath } from "../../config/settings";
import { _resetProjectsCache, _setProjectsConfigPath, _resetMantleConfigCache, _setMantleConfigPath } from "../../config/projects";
import type { PipelineContext } from "../runner";
import type { CloneSyncState, syncTarget } from "../../extensions/impact-checker/clone-manager";
import type { ImpactCheckVerdict, runImpactCheck } from "../../extensions/impact-checker/checker";
import type { GateInput, upsertImpactChecks } from "../../extensions/impact-checker/index";

const BASE_SETTINGS = {
  llm: {
    model: "test-model",
    baseUrlEnvVar: "LLM_BASE_URL",
    apiKeyEnvVar: "LLM_API_KEY",
    maxTokensPerCall: 4096,
    diffTokenBudget: 8000,
    maxManifestEntries: 100,
  },
  lark: { webhookUrlEnvVar: "LARK_WEBHOOK_URL" },
  github: { tokenEnvVar: "GITHUB_TOKEN" },
  schedule: { dailyCron: "0 9 * * *", weeklyCron: "30 9 * * 1", monthlyCron: "0 10 1 * *", timezone: "UTC" },
  budget: { monthlyCap: 80, warningThreshold: 0.8, cutoffThreshold: 1.0 },
};

const IMPACT_CHECK_CONFIG = {
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

const VALID_MANTLE_CONFIG = {
  mantleTargets: [],
  counterpartRelationships: [],
};

const MANTLE_CONFIG_WITH_TARGET = {
  mantleTargets: [
    {
      projectId: "org/target-repo",
      tags: [],
      repoUrl: "https://github.com/org/target-repo",
    },
  ],
  counterpartRelationships: [
    {
      source: "org/source-repo",
      targets: ["org/target-repo"],
      relationship: "fork_of",
      reason: "test fork",
    },
  ],
};

function makeCtx(): PipelineContext {
  return {
    stageResults: new Map(),
    reportMode: "daily",
    dispatchEnabled: true,
  };
}

function makeAvailableCloneState(targetId: string): CloneSyncState {
  return {
    lastFetchAt: new Date().toISOString(),
    commitHash: "abc123",
    available: true,
    cloneDir: `/tmp/clones/${targetId}`,
  };
}

function makeVerdictResult(): ImpactCheckVerdict {
  return {
    affected: "yes",
    severity: "critical",
    impactType: "behavior_change",
    evidenceKind: "code_evidence",
    evidence: [{ file: "src/main.ts", lines: "10-20", snippet: "foo()", note: "changed" }],
    confidence: "high",
    summary: "The target is affected",
    recommendedAction: "Review the change",
    tokensUsed: 1000,
    cost: 0.01,
    toolSteps: 3,
    truncatedByStepCount: false,
    truncatedByCost: false,
    evidenceVerificationFailed: false,
  };
}

function applySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      org TEXT NOT NULL,
      repo TEXT NOT NULL,
      url TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pull_requests (
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
      diff_path TEXT,
      diff_status TEXT DEFAULT 'missing',
      analysis_status TEXT DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0,
      last_error TEXT,
      fetched_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(project_id, pr_number)
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      technical_detail TEXT,
      direction_signal TEXT,
      significance TEXT,
      categories TEXT,
      model_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      estimated_cost_usd REAL,
      analyzed_at INTEGER DEFAULT (unixepoch()),
      downstream_impact_hint TEXT DEFAULT 'none',
      downstream_impact_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS impact_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL,
      analysis_id INTEGER NOT NULL,
      target_project_id TEXT NOT NULL,
      relationship TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      affected TEXT,
      severity TEXT,
      impact_type TEXT,
      evidence_kind TEXT,
      evidence TEXT,
      confidence TEXT,
      summary TEXT,
      recommended_action TEXT,
      target_commit TEXT,
      prompt_version TEXT NOT NULL DEFAULT 'v1',
      config_hash TEXT NOT NULL DEFAULT 'testhash',
      input_tokens INTEGER,
      output_tokens INTEGER,
      model_id TEXT,
      estimated_cost_usd REAL,
      tool_steps INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      alert_card_json TEXT,
      alert_attempt_count INTEGER NOT NULL DEFAULT 0,
      alert_dispatched_at INTEGER,
      lark_message_id TEXT,
      checked_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(pr_id, target_project_id)
    );
    CREATE TABLE IF NOT EXISTS budget_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT NOT NULL,
      source TEXT NOT NULL,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    );
  `);
}

function insertAnalysisOnly(db: Database): { prId: number; analysisId: number } {
  db.exec(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/source-repo', 'org', 'source-repo', 'https://github.com/org/source-repo')`);
  const now = Math.floor(Date.now() / 1000);
  db.query(`
    INSERT INTO pull_requests (project_id, pr_number, title, body, merged_at, diff_status)
    VALUES ('org/source-repo', 10, 'Gate PR', 'Gate body', ?, 'missing')
  `).run(now - 3600);
  const pr = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
  db.query(`
    INSERT INTO analyses (pr_id, project_id, summary, technical_detail, downstream_impact_hint, significance)
    VALUES (?, 'org/source-repo', 'Gate summary', 'Gate details', 'likely', 'notable')
  `).run(pr.id);
  const analysis = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
  return { prId: pr.id, analysisId: analysis.id };
}

function insertTestData(db: Database): { prId: number; analysisId: number; checkId: number } {
  db.exec(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/source-repo', 'org', 'source-repo', 'https://github.com/org/source-repo')`);

  const now = Math.floor(Date.now() / 1000);
  db.query(`
    INSERT INTO pull_requests (project_id, pr_number, title, body, merged_at, diff_status)
    VALUES ('org/source-repo', 1, 'Test PR', 'Test body', ?, 'missing')
  `).run(now - 3600);

  const pr = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;

  db.query(`
    INSERT INTO analyses (pr_id, project_id, summary, technical_detail, downstream_impact_hint, significance)
    VALUES (?, 'org/source-repo', 'Analysis summary', 'Technical details', 'likely', 'notable')
  `).run(pr.id);

  const analysis = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;

  db.query(`
    INSERT INTO impact_checks (pr_id, analysis_id, target_project_id, relationship, status, prompt_version, config_hash)
    VALUES (?, ?, 'org/target-repo', 'fork_of', 'pending', 'v1', 'testhash')
  `).run(pr.id, analysis.id);

  const check = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;

  return { prId: pr.id, analysisId: analysis.id, checkId: check.id };
}

describe("impact-check stage — unit", () => {
  let settingsTmp: string;
  let mantleTmp: string;
  let projectsTmp: string;

  beforeEach(() => {
    settingsTmp = join(tmpdir(), `ic-settings-${Date.now()}.json`);
    mantleTmp = join(tmpdir(), `ic-mantle-${Date.now()}.json`);
    projectsTmp = join(tmpdir(), `ic-projects-${Date.now()}.json`);
    writeFileSync(mantleTmp, JSON.stringify(VALID_MANTLE_CONFIG));
    writeFileSync(projectsTmp, JSON.stringify([]));
    _setMantleConfigPath(mantleTmp);
    _setProjectsConfigPath(projectsTmp);
    _resetMantleConfigCache();
    _resetProjectsCache();
    process.env["LLM_BASE_URL"] = "https://example.com/v1";
    process.env["LLM_API_KEY"] = "sk-test";
    process.env["GITHUB_TOKEN"] = "ghp_test";
  });

  afterEach(() => {
    _resetSettingsCache();
    _resetProjectsCache();
    _resetMantleConfigCache();
    _setSettingsConfigPath(null);
    _setProjectsConfigPath(null);
    _setMantleConfigPath(null);
    try { unlinkSync(settingsTmp); } catch {}
    try { unlinkSync(mantleTmp); } catch {}
    try { unlinkSync(projectsTmp); } catch {}
    delete process.env["LLM_BASE_URL"];
    delete process.env["LLM_API_KEY"];
    delete process.env["GITHUB_TOKEN"];
  });

  it("stage name is 'impact-check'", () => {
    expect(stage.name).toBe("impact-check");
  });

  it("returns success=true immediately when impactCheck is not configured", async () => {
    writeFileSync(settingsTmp, JSON.stringify(BASE_SETTINGS));
    _setSettingsConfigPath(settingsTmp);
    _resetSettingsCache();

    const result = await stage.execute(makeCtx());

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns success=true immediately when impactCheck.enabled=false", async () => {
    writeFileSync(settingsTmp, JSON.stringify({ ...BASE_SETTINGS, impactCheck: { ...IMPACT_CHECK_CONFIG, enabled: false } }));
    _setSettingsConfigPath(settingsTmp);
    _resetSettingsCache();

    const result = await stage.execute(makeCtx());

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns success=false without throwing when DB is unavailable", async () => {
    writeFileSync(settingsTmp, JSON.stringify({ ...BASE_SETTINGS, impactCheck: IMPACT_CHECK_CONFIG }));
    _setSettingsConfigPath(settingsTmp);
    _resetSettingsCache();

    let threw = false;
    let result;
    try {
      result = await stage.execute(makeCtx());
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(typeof result?.success).toBe("boolean");
  });
});

describe("impact-check stage — agentic flow", () => {
  let settingsTmp: string;
  let mantleTmp: string;
  let projectsTmp: string;
  let db: Database;

  beforeEach(() => {
    settingsTmp = join(tmpdir(), `ic-agentic-settings-${Date.now()}.json`);
    mantleTmp = join(tmpdir(), `ic-agentic-mantle-${Date.now()}.json`);
    projectsTmp = join(tmpdir(), `ic-agentic-projects-${Date.now()}.json`);

    writeFileSync(settingsTmp, JSON.stringify({ ...BASE_SETTINGS, impactCheck: IMPACT_CHECK_CONFIG }));
    writeFileSync(mantleTmp, JSON.stringify(MANTLE_CONFIG_WITH_TARGET));
    writeFileSync(projectsTmp, JSON.stringify([]));

    _setSettingsConfigPath(settingsTmp);
    _setMantleConfigPath(mantleTmp);
    _setProjectsConfigPath(projectsTmp);
    _resetSettingsCache();
    _resetMantleConfigCache();
    _resetProjectsCache();

    process.env["LLM_BASE_URL"] = "https://example.com/v1";
    process.env["LLM_API_KEY"] = "sk-test";
    process.env["GITHUB_TOKEN"] = "ghp_test";

    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    _resetSettingsCache();
    _resetProjectsCache();
    _resetMantleConfigCache();
    _setSettingsConfigPath(null);
    _setProjectsConfigPath(null);
    _setMantleConfigPath(null);
    try { unlinkSync(settingsTmp); } catch {}
    try { unlinkSync(mantleTmp); } catch {}
    try { unlinkSync(projectsTmp); } catch {}
    delete process.env["LLM_BASE_URL"];
    delete process.env["LLM_API_KEY"];
    delete process.env["GITHUB_TOKEN"];
    db.close();
  });

  it("calls upsertImpactChecksFn with gateInputs built from unchecked analyses", async () => {
    const { prId, analysisId } = insertAnalysisOnly(db);

    let capturedInputs: GateInput[] | undefined;
    const mockUpsert = (_dbArg: Database, inputs: GateInput[], ...rest: unknown[]) => {
      capturedInputs = inputs;
      return 0;
    };

    const deps: ImpactCheckStageDeps = {
      getSettingsFn: (() => ({ ...BASE_SETTINGS, impactCheck: IMPACT_CHECK_CONFIG })) as unknown as typeof getSettings,
      getDbFn: () => db,
      upsertImpactChecksFn: mockUpsert as unknown as typeof upsertImpactChecks,
      processQueueFn: (() => ({})) as unknown as ImpactCheckStageDeps["processQueueFn"],
      syncTargetFn: (() => Promise.resolve()) as unknown as typeof syncTarget,
    };

    await execute(makeCtx(), deps);

    expect(capturedInputs).toBeDefined();
    const inputs = capturedInputs!;
    expect(inputs.length).toBe(1);
    const first = inputs[0]!;
    expect(first.analysisId).toBe(analysisId);
    expect(first.prId).toBe(prId);
    expect(first.projectId).toBe("org/source-repo");
    expect(first.significance).toBe("notable");
    expect(first.downstreamImpactHint).toBe("likely");
  });

  it("still sends an analysis to upsert when it already has an impact row for another target", async () => {
    const { prId, analysisId } = insertAnalysisOnly(db);
    db.query(`
      INSERT INTO impact_checks (pr_id, analysis_id, target_project_id, relationship, status, prompt_version, config_hash)
      VALUES (?, ?, 'org/existing-target', 'fork_of', 'complete', 'v1', 'existinghash')
    `).run(prId, analysisId);

    let capturedInputs: GateInput[] | undefined;
    const mockUpsert = (_dbArg: Database, inputs: GateInput[], ...rest: unknown[]) => {
      capturedInputs = inputs;
      return 0;
    };

    const deps: ImpactCheckStageDeps = {
      getSettingsFn: (() => ({ ...BASE_SETTINGS, impactCheck: IMPACT_CHECK_CONFIG })) as unknown as typeof getSettings,
      getDbFn: () => db,
      upsertImpactChecksFn: mockUpsert as unknown as typeof upsertImpactChecks,
      processQueueFn: (() => ({})) as unknown as ImpactCheckStageDeps["processQueueFn"],
      syncTargetFn: (() => Promise.resolve()) as unknown as typeof syncTarget,
    };

    await execute(makeCtx(), deps);

    expect(capturedInputs).toBeDefined();
    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs![0]!.analysisId).toBe(analysisId);
  });

  it("does not send analyses outside maxAgeDays to upsert", async () => {
    const { analysisId } = insertAnalysisOnly(db);
    const oldMergedAt = Math.floor(Date.now() / 1000) - (IMPACT_CHECK_CONFIG.maxAgeDays + 2) * 86400;
    db.query("UPDATE pull_requests SET merged_at = ? WHERE project_id = 'org/source-repo'").run(oldMergedAt);

    let capturedInputs: GateInput[] | undefined;
    const mockUpsert = (_dbArg: Database, inputs: GateInput[], ...rest: unknown[]) => {
      capturedInputs = inputs;
      return 0;
    };

    const deps: ImpactCheckStageDeps = {
      getSettingsFn: (() => ({ ...BASE_SETTINGS, impactCheck: IMPACT_CHECK_CONFIG })) as unknown as typeof getSettings,
      getDbFn: () => db,
      upsertImpactChecksFn: mockUpsert as unknown as typeof upsertImpactChecks,
      processQueueFn: (() => ({})) as unknown as ImpactCheckStageDeps["processQueueFn"],
      syncTargetFn: (() => Promise.resolve()) as unknown as typeof syncTarget,
    };

    await execute(makeCtx(), deps);

    expect(capturedInputs).toBeDefined();
    expect(capturedInputs).toHaveLength(0);
    expect(analysisId).toBeGreaterThan(0);
  });

  it("calls syncTarget once per unique target, not once per pending row", async () => {
    // Insert two pending rows for the same target
    insertTestData(db);

    db.exec(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/source-repo-2', 'org', 'source-repo-2', 'https://github.com/org/source-repo-2')`);
    const now = Math.floor(Date.now() / 1000);
    db.query(`
      INSERT INTO pull_requests (project_id, pr_number, title, body, merged_at, diff_status)
      VALUES ('org/source-repo-2', 2, 'Second PR', null, ?, 'missing')
    `).run(now - 7200);

    const pr2 = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
    db.query(`
      INSERT INTO analyses (pr_id, project_id, summary, downstream_impact_hint, significance)
      VALUES (?, 'org/source-repo-2', 'Second summary', 'likely', 'notable')
    `).run(pr2.id);
    const analysis2 = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;

    // Insert a second pending check for the same target
    db.query(`
      INSERT INTO impact_checks (pr_id, analysis_id, target_project_id, relationship, status, prompt_version, config_hash)
      VALUES (?, ?, 'org/target-repo', 'fork_of', 'pending', 'v1', 'testhash2')
    `).run(pr2.id, analysis2.id);

    const syncCalls: string[] = [];
    const mockSyncTarget = async (target: { projectId: string }, _opts: unknown): Promise<CloneSyncState> => {
      syncCalls.push(target.projectId);
      return makeAvailableCloneState(target.projectId);
    };

    const mockRunImpactCheck = async (_input: unknown): Promise<ImpactCheckVerdict> => makeVerdictResult();

    const deps: ImpactCheckStageDeps = {
      getSettingsFn: (() => ({ ...BASE_SETTINGS, impactCheck: IMPACT_CHECK_CONFIG })) as unknown as typeof getSettings,
      getDbFn: () => db,
      upsertImpactChecksFn: (() => 0) as unknown as typeof upsertImpactChecks,
      processQueueFn: (() => ({})) as unknown as ImpactCheckStageDeps["processQueueFn"],
      syncTargetFn: mockSyncTarget as typeof syncTarget,
      runImpactCheckFn: mockRunImpactCheck as typeof runImpactCheck,
    };

    await execute(makeCtx(), deps);

    // Only one unique target → syncTarget called exactly once
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0]).toBe("org/target-repo");
  });

  it("writes verdict to impact_checks on success", async () => {
    const { checkId } = insertTestData(db);

    const mockSyncTarget = async (_target: unknown, _opts: unknown): Promise<CloneSyncState> =>
      makeAvailableCloneState("org/target-repo");

    const mockRunImpactCheck = async (_input: unknown): Promise<ImpactCheckVerdict> => makeVerdictResult();

    const deps: ImpactCheckStageDeps = {
      getSettingsFn: (() => ({ ...BASE_SETTINGS, impactCheck: IMPACT_CHECK_CONFIG })) as unknown as typeof getSettings,
      getDbFn: () => db,
      upsertImpactChecksFn: (() => 0) as unknown as typeof upsertImpactChecks,
      processQueueFn: (() => ({})) as unknown as ImpactCheckStageDeps["processQueueFn"],
      syncTargetFn: mockSyncTarget as typeof syncTarget,
      runImpactCheckFn: mockRunImpactCheck as typeof runImpactCheck,
    };

    const result = await execute(makeCtx(), deps);

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(1);

    const row = db
      .query<{ status: string; affected: string; confidence: string; target_commit: string }, [number]>(
        "SELECT status, affected, confidence, target_commit FROM impact_checks WHERE id = ?"
      )
      .get(checkId);

    expect(row?.status).toBe("complete");
    expect(row?.affected).toBe("yes");
    expect(row?.confidence).toBe("high");
    expect(row?.target_commit).toBe("abc123");
  });

  it("passes the source-specific relationship reason to the checker when a target has multiple relationships of the same type", async () => {
    const config = {
      mantleTargets: [
        {
          projectId: "org/target-repo",
          tags: [],
          repoUrl: "https://github.com/org/target-repo",
        },
      ],
      counterpartRelationships: [
        {
          source: "org/other-source",
          targets: ["org/target-repo"],
          relationship: "depends_on",
          reason: "wrong source reason",
        },
        {
          source: "org/source-repo",
          targets: ["org/target-repo"],
          relationship: "depends_on",
          reason: "correct source reason",
        },
      ],
    };
    writeFileSync(mantleTmp, JSON.stringify(config));
    _resetMantleConfigCache();

    const { prId, analysisId } = insertAnalysisOnly(db);
    db.query(`
      INSERT INTO impact_checks (pr_id, analysis_id, target_project_id, relationship, status, prompt_version, config_hash)
      VALUES (?, ?, 'org/target-repo', 'depends_on', 'pending', 'v1', 'testhash')
    `).run(prId, analysisId);

    const mockSyncTarget = async (_target: unknown, _opts: unknown): Promise<CloneSyncState> =>
      makeAvailableCloneState("org/target-repo");

    let capturedReason: string | undefined;
    const mockRunImpactCheck = async (input: Parameters<typeof runImpactCheck>[0]): Promise<ImpactCheckVerdict> => {
      capturedReason = input.relationship.reason;
      return makeVerdictResult();
    };

    const deps: ImpactCheckStageDeps = {
      getSettingsFn: (() => ({ ...BASE_SETTINGS, impactCheck: IMPACT_CHECK_CONFIG })) as unknown as typeof getSettings,
      getDbFn: () => db,
      upsertImpactChecksFn: (() => 0) as unknown as typeof upsertImpactChecks,
      processQueueFn: (() => ({})) as unknown as ImpactCheckStageDeps["processQueueFn"],
      syncTargetFn: mockSyncTarget as typeof syncTarget,
      runImpactCheckFn: mockRunImpactCheck as typeof runImpactCheck,
    };

    const result = await execute(makeCtx(), deps);

    expect(result.success).toBe(true);
    expect(capturedReason).toBe("correct source reason");
  });

  it("writes failed status and increments retry_count on runImpactCheck error", async () => {
    const { checkId } = insertTestData(db);

    const mockSyncTarget = async (_target: unknown, _opts: unknown): Promise<CloneSyncState> =>
      makeAvailableCloneState("org/target-repo");

    const mockRunImpactCheck = async (_input: unknown): Promise<ImpactCheckVerdict> => {
      throw new Error("LLM API unreachable");
    };

    const deps: ImpactCheckStageDeps = {
      getSettingsFn: (() => ({ ...BASE_SETTINGS, impactCheck: IMPACT_CHECK_CONFIG })) as unknown as typeof getSettings,
      getDbFn: () => db,
      upsertImpactChecksFn: (() => 0) as unknown as typeof upsertImpactChecks,
      processQueueFn: (() => ({})) as unknown as ImpactCheckStageDeps["processQueueFn"],
      syncTargetFn: mockSyncTarget as typeof syncTarget,
      runImpactCheckFn: mockRunImpactCheck as typeof runImpactCheck,
    };

    const result = await execute(makeCtx(), deps);

    // Stage itself succeeds even though the individual check failed
    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(0);

    const row = db
      .query<{ status: string; retry_count: number; last_error: string; checked_at: number | null }, [number]>(
        "SELECT status, retry_count, last_error, checked_at FROM impact_checks WHERE id = ?"
      )
      .get(checkId);

    expect(row?.status).toBe("failed");
    expect(row?.retry_count).toBe(1);
    expect(row?.last_error).toBe("LLM API unreachable");
    expect(row?.checked_at).not.toBeNull();
  });

  it("returns success=true with itemsProcessed=0 when pending queue is empty", async () => {
    // No impact_checks rows inserted, so queue is empty

    const syncCalls: string[] = [];
    const mockSyncTarget = async (target: { projectId: string }, _opts: unknown): Promise<CloneSyncState> => {
      syncCalls.push(target.projectId);
      return makeAvailableCloneState(target.projectId);
    };

    const deps: ImpactCheckStageDeps = {
      getSettingsFn: (() => ({ ...BASE_SETTINGS, impactCheck: IMPACT_CHECK_CONFIG })) as unknown as typeof getSettings,
      getDbFn: () => db,
      upsertImpactChecksFn: (() => 0) as unknown as typeof upsertImpactChecks,
      processQueueFn: (() => ({})) as unknown as ImpactCheckStageDeps["processQueueFn"],
      syncTargetFn: mockSyncTarget as typeof syncTarget,
    };

    const result = await execute(makeCtx(), deps);

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(0);
    expect(syncCalls).toHaveLength(0);
  });
});

describe("impact-check stage — alert card dispatch", () => {
  let settingsTmp: string;
  let mantleTmp: string;
  let projectsTmp: string;
  let db: Database;

  beforeEach(() => {
    settingsTmp = join(tmpdir(), `ic-alert-settings-${Date.now()}.json`);
    mantleTmp = join(tmpdir(), `ic-alert-mantle-${Date.now()}.json`);
    projectsTmp = join(tmpdir(), `ic-alert-projects-${Date.now()}.json`);

    writeFileSync(settingsTmp, JSON.stringify({ ...BASE_SETTINGS, impactCheck: IMPACT_CHECK_CONFIG }));
    writeFileSync(mantleTmp, JSON.stringify(MANTLE_CONFIG_WITH_TARGET));
    writeFileSync(projectsTmp, JSON.stringify([]));

    _setSettingsConfigPath(settingsTmp);
    _setMantleConfigPath(mantleTmp);
    _setProjectsConfigPath(projectsTmp);
    _resetSettingsCache();
    _resetMantleConfigCache();
    _resetProjectsCache();

    process.env["LLM_BASE_URL"] = "https://example.com/v1";
    process.env["LLM_API_KEY"] = "sk-test";
    process.env["GITHUB_TOKEN"] = "ghp_test";

    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    _resetSettingsCache();
    _resetProjectsCache();
    _resetMantleConfigCache();
    _setSettingsConfigPath(null);
    _setProjectsConfigPath(null);
    _setMantleConfigPath(null);
    try { unlinkSync(settingsTmp); } catch {}
    try { unlinkSync(mantleTmp); } catch {}
    try { unlinkSync(projectsTmp); } catch {}
    delete process.env["LLM_BASE_URL"];
    delete process.env["LLM_API_KEY"];
    delete process.env["GITHUB_TOKEN"];
    db.close();
  });

  function makeDispatchSettings(webhookUrl?: string) {
    return {
      ...BASE_SETTINGS,
      impactCheck: IMPACT_CHECK_CONFIG,
      lark: { webhookUrlEnvVar: "LARK_WEBHOOK_URL", ...(webhookUrl ? { webhookUrl } : {}) },
    };
  }

  it("writes alert_card_json and alert_dispatched_at on first send success", async () => {
    const { checkId } = insertTestData(db);

    const mockSyncTarget = async (_target: unknown, _opts: unknown): Promise<CloneSyncState> =>
      makeAvailableCloneState("org/target-repo");
    const mockRunImpactCheck = async (_input: unknown): Promise<ImpactCheckVerdict> => makeVerdictResult();
    const mockSendCard = async (_url: string, _card: object) => ({
      code: 0,
      msg: "success",
      data: { message_id: "alert-msg-001" },
    });

    const deps: ImpactCheckStageDeps = {
      getSettingsFn: (() => makeDispatchSettings("https://open.larksuite.com/test")) as unknown as typeof getSettings,
      getDbFn: () => db,
      upsertImpactChecksFn: (() => 0) as unknown as typeof upsertImpactChecks,
      processQueueFn: (() => ({})) as unknown as ImpactCheckStageDeps["processQueueFn"],
      syncTargetFn: mockSyncTarget as typeof syncTarget,
      runImpactCheckFn: mockRunImpactCheck as typeof runImpactCheck,
      sendCardFn: mockSendCard,
    };

    const result = await execute({ stageResults: new Map(), reportMode: "daily", dispatchEnabled: true }, deps);

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(1);

    const row = db.query<{
      alert_card_json: string | null;
      alert_dispatched_at: number | null;
      alert_attempt_count: number;
      lark_message_id: string | null;
    }, [number]>(
      "SELECT alert_card_json, alert_dispatched_at, alert_attempt_count, lark_message_id FROM impact_checks WHERE id = ?"
    ).get(checkId)!;

    expect(row.alert_card_json).not.toBeNull();
    expect(row.alert_dispatched_at).not.toBeNull();
    expect(row.alert_attempt_count).toBe(1);
    expect(row.lark_message_id).toBe("alert-msg-001");
  });

  it("increments alert_attempt_count only on first send failure (alert_dispatched_at stays null)", async () => {
    const { checkId } = insertTestData(db);

    const mockSyncTarget = async (_target: unknown, _opts: unknown): Promise<CloneSyncState> =>
      makeAvailableCloneState("org/target-repo");
    const mockRunImpactCheck = async (_input: unknown): Promise<ImpactCheckVerdict> => makeVerdictResult();
    const mockSendCard = async (_url: string, _card: object) => ({
      code: 500,
      msg: "webhook error",
    });

    const deps: ImpactCheckStageDeps = {
      getSettingsFn: (() => makeDispatchSettings("https://open.larksuite.com/test")) as unknown as typeof getSettings,
      getDbFn: () => db,
      upsertImpactChecksFn: (() => 0) as unknown as typeof upsertImpactChecks,
      processQueueFn: (() => ({})) as unknown as ImpactCheckStageDeps["processQueueFn"],
      syncTargetFn: mockSyncTarget as typeof syncTarget,
      runImpactCheckFn: mockRunImpactCheck as typeof runImpactCheck,
      sendCardFn: mockSendCard,
    };

    await execute({ stageResults: new Map(), reportMode: "daily", dispatchEnabled: true }, deps);

    const row = db.query<{
      alert_card_json: string | null;
      alert_dispatched_at: number | null;
      alert_attempt_count: number;
    }, [number]>(
      "SELECT alert_card_json, alert_dispatched_at, alert_attempt_count FROM impact_checks WHERE id = ?"
    ).get(checkId)!;

    expect(row.alert_card_json).not.toBeNull();
    expect(row.alert_dispatched_at).toBeNull();
    expect(row.alert_attempt_count).toBe(1);
  });

  it("does not send and does not increment attempt_count when dispatchEnabled=false", async () => {
    const { checkId } = insertTestData(db);

    let sendCalled = false;
    const mockSyncTarget = async (_target: unknown, _opts: unknown): Promise<CloneSyncState> =>
      makeAvailableCloneState("org/target-repo");
    const mockRunImpactCheck = async (_input: unknown): Promise<ImpactCheckVerdict> => makeVerdictResult();
    const mockSendCard = async (_url: string, _card: object) => {
      sendCalled = true;
      return { code: 0, msg: "success", data: { message_id: "msg" } };
    };

    const deps: ImpactCheckStageDeps = {
      getSettingsFn: (() => makeDispatchSettings("https://open.larksuite.com/test")) as unknown as typeof getSettings,
      getDbFn: () => db,
      upsertImpactChecksFn: (() => 0) as unknown as typeof upsertImpactChecks,
      processQueueFn: (() => ({})) as unknown as ImpactCheckStageDeps["processQueueFn"],
      syncTargetFn: mockSyncTarget as typeof syncTarget,
      runImpactCheckFn: mockRunImpactCheck as typeof runImpactCheck,
      sendCardFn: mockSendCard,
    };

    await execute({ stageResults: new Map(), reportMode: "daily", dispatchEnabled: false }, deps);

    expect(sendCalled).toBe(false);

    const row = db.query<{
      alert_card_json: string | null;
      alert_dispatched_at: number | null;
      alert_attempt_count: number;
    }, [number]>(
      "SELECT alert_card_json, alert_dispatched_at, alert_attempt_count FROM impact_checks WHERE id = ?"
    ).get(checkId)!;

    expect(row.alert_card_json).not.toBeNull();
    expect(row.alert_dispatched_at).toBeNull();
    expect(row.alert_attempt_count).toBe(0);
  });

  it("does not send and does not increment when webhook is not configured", async () => {
    const { checkId } = insertTestData(db);

    let sendCalled = false;
    const mockSyncTarget = async (_target: unknown, _opts: unknown): Promise<CloneSyncState> =>
      makeAvailableCloneState("org/target-repo");
    const mockRunImpactCheck = async (_input: unknown): Promise<ImpactCheckVerdict> => makeVerdictResult();
    const mockSendCard = async (_url: string, _card: object) => {
      sendCalled = true;
      return { code: 0, msg: "success", data: { message_id: "msg" } };
    };

    const deps: ImpactCheckStageDeps = {
      // No webhookUrl in lark settings
      getSettingsFn: (() => makeDispatchSettings()) as unknown as typeof getSettings,
      getDbFn: () => db,
      upsertImpactChecksFn: (() => 0) as unknown as typeof upsertImpactChecks,
      processQueueFn: (() => ({})) as unknown as ImpactCheckStageDeps["processQueueFn"],
      syncTargetFn: mockSyncTarget as typeof syncTarget,
      runImpactCheckFn: mockRunImpactCheck as typeof runImpactCheck,
      sendCardFn: mockSendCard,
    };

    await execute({ stageResults: new Map(), reportMode: "daily", dispatchEnabled: true }, deps);

    expect(sendCalled).toBe(false);

    const row = db.query<{
      alert_card_json: string | null;
      alert_attempt_count: number;
    }, [number]>(
      "SELECT alert_card_json, alert_attempt_count FROM impact_checks WHERE id = ?"
    ).get(checkId)!;

    expect(row.alert_card_json).not.toBeNull();
    expect(row.alert_attempt_count).toBe(0);
  });

  it("does not render alert card for non-qualifying verdicts (affected!=yes)", async () => {
    const { checkId } = insertTestData(db);

    let sendCalled = false;
    const mockSyncTarget = async (_target: unknown, _opts: unknown): Promise<CloneSyncState> =>
      makeAvailableCloneState("org/target-repo");
    const mockRunImpactCheck = async (_input: unknown): Promise<ImpactCheckVerdict> => ({
      ...makeVerdictResult(),
      affected: "no",
    });
    const mockSendCard = async (_url: string, _card: object) => {
      sendCalled = true;
      return { code: 0, msg: "success", data: { message_id: "msg" } };
    };

    const deps: ImpactCheckStageDeps = {
      getSettingsFn: (() => makeDispatchSettings("https://open.larksuite.com/test")) as unknown as typeof getSettings,
      getDbFn: () => db,
      upsertImpactChecksFn: (() => 0) as unknown as typeof upsertImpactChecks,
      processQueueFn: (() => ({})) as unknown as ImpactCheckStageDeps["processQueueFn"],
      syncTargetFn: mockSyncTarget as typeof syncTarget,
      runImpactCheckFn: mockRunImpactCheck as typeof runImpactCheck,
      sendCardFn: mockSendCard,
    };

    await execute({ stageResults: new Map(), reportMode: "daily", dispatchEnabled: true }, deps);

    expect(sendCalled).toBe(false);

    const row = db.query<{ alert_card_json: string | null }, [number]>(
      "SELECT alert_card_json FROM impact_checks WHERE id = ?"
    ).get(checkId)!;

    expect(row.alert_card_json).toBeNull();
  });
});

describe("stage order — impact-check is between analyze and report", () => {
  it("getRunStages includes impact-check between analyze and report (no-dispatch)", () => {
    const names = getRunStages(true).map((s) => s.name);
    expect(names).toEqual(["collect", "analyze", "impact-check", "report"]);
  });

  it("getRunStages includes impact-check between analyze and report (with dispatch)", () => {
    const names = getRunStages(false).map((s) => s.name);
    expect(names).toEqual(["collect", "analyze", "impact-check", "report", "dispatch"]);
  });

  it("getE2EStages includes impact-check between analyze and report", () => {
    const names = getE2EStages().map((s) => s.name);
    expect(names).toEqual(["collect", "analyze", "impact-check", "report", "dispatch"]);
  });
});
