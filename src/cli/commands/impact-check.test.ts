import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { requeueById, requeueSkippedBudget } from "./impact-check";

function createDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, org TEXT NOT NULL, repo TEXT NOT NULL, url TEXT NOT NULL,
      source TEXT DEFAULT 'subscription', active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE pull_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL, pr_number INTEGER NOT NULL, title TEXT NOT NULL,
      merged_at INTEGER, fetched_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(project_id, pr_number)
    );
    CREATE TABLE analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL, project_id TEXT NOT NULL, summary TEXT NOT NULL,
      analyzed_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE impact_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL,
      analysis_id INTEGER NOT NULL,
      target_project_id TEXT NOT NULL,
      relationship TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      affected TEXT,
      impact_type TEXT, evidence_kind TEXT, evidence TEXT, confidence TEXT,
      summary TEXT, recommended_action TEXT,
      prompt_version TEXT NOT NULL DEFAULT 'v1',
      config_hash TEXT NOT NULL DEFAULT 'h',
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
  `);
  db.query("INSERT INTO projects (id, org, repo, url) VALUES ('ethereum/reth', 'ethereum', 'reth', 'https://github.com/ethereum/reth')").run();
  db.query("INSERT INTO pull_requests (project_id, pr_number, title, merged_at) VALUES ('ethereum/reth', 1, 'Test PR', ?)").run(Math.floor(Date.now() / 1000) - 86400);
  db.query("INSERT INTO analyses (pr_id, project_id, summary) VALUES (1, 'ethereum/reth', 'test')").run();
  return db;
}

function insertCheck(
  db: Database,
  overrides: Partial<{
    prId: number;
    analysisId: number;
    targetProjectId: string;
    relationship: string;
    status: string;
    affected: string | null;
    checkedAt: number | null;
    retryCount: number;
    alertAttemptCount: number;
    lastError: string | null;
    alertCardJson: string | null;
    larkMessageId: string | null;
    alertDispatchedAt: number | null;
    summary: string | null;
    impactType: string | null;
    evidenceKind: string | null;
    evidence: string | null;
    confidence: string | null;
    recommendedAction: string | null;
  }> = {}
): number {
  const o = {
    prId: 1,
    analysisId: 1,
    targetProjectId: "mantle/reth",
    relationship: "fork_of",
    status: "complete",
    affected: "yes",
    checkedAt: Math.floor(Date.now() / 1000) - 100,
    retryCount: 0,
    alertAttemptCount: 1,
    lastError: null,
    alertCardJson: '{"type":"card"}',
    larkMessageId: "msg-001",
    alertDispatchedAt: Math.floor(Date.now() / 1000) - 50,
    summary: "Impact found",
    impactType: "breaking",
    evidenceKind: "diff",
    evidence: "[]",
    confidence: "high",
    recommendedAction: "review",
    ...overrides,
  };

  db.query(`
    INSERT INTO impact_checks
      (pr_id, analysis_id, target_project_id, relationship, status, affected, checked_at,
       retry_count, alert_attempt_count, last_error, alert_card_json, lark_message_id,
       alert_dispatched_at, summary, impact_type, evidence_kind, evidence, confidence, recommended_action)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    o.prId, o.analysisId, o.targetProjectId, o.relationship, o.status, o.affected,
    o.checkedAt, o.retryCount, o.alertAttemptCount, o.lastError, o.alertCardJson,
    o.larkMessageId, o.alertDispatchedAt, o.summary, o.impactType, o.evidenceKind,
    o.evidence, o.confidence, o.recommendedAction
  );

  return Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id);
}

// ---- requeueById ----

describe("requeueById — dry run", () => {
  let db: Database;
  let checkId: number;

  beforeEach(() => {
    db = createDb();
    checkId = insertCheck(db);
  });

  it("returns before/after same row without mutating when yes=false", () => {
    const result = requeueById(db, checkId, false);

    expect(result.mutated).toBe(false);
    expect(result.before).not.toBeNull();
    expect(result.before!.status).toBe("complete");

    const row = db.query<{ status: string }, [number]>("SELECT status FROM impact_checks WHERE id = ?")
      .get(checkId)!;
    expect(row.status).toBe("complete");
  });

  it("returns null before/after when id does not exist", () => {
    const result = requeueById(db, 9999, false);
    expect(result.before).toBeNull();
    expect(result.after).toBeNull();
  });
});

describe("requeueById — confirmed (--yes)", () => {
  let db: Database;
  let checkId: number;

  beforeEach(() => {
    db = createDb();
    checkId = insertCheck(db);
  });

  it("resets status to pending and clears all verdict + alert fields", () => {
    const result = requeueById(db, checkId, true);

    expect(result.mutated).toBe(true);
    expect(result.after!.status).toBe("pending");
    expect(result.after!.retry_count).toBe(0);
    expect(result.after!.alert_attempt_count).toBe(0);
    expect(result.after!.affected).toBeNull();
    expect(result.after!.checked_at).toBeNull();

    const row = db.query<{
      status: string;
      affected: string | null;
      impact_type: string | null;
      evidence_kind: string | null;
      evidence: string | null;
      confidence: string | null;
      summary: string | null;
      recommended_action: string | null;
      checked_at: number | null;
      alert_dispatched_at: number | null;
      lark_message_id: string | null;
      alert_card_json: string | null;
      last_error: string | null;
      retry_count: number;
      alert_attempt_count: number;
    }, [number]>(`
      SELECT status, affected, impact_type, evidence_kind, evidence, confidence, summary,
             recommended_action, checked_at, alert_dispatched_at, lark_message_id,
             alert_card_json, last_error, retry_count, alert_attempt_count
      FROM impact_checks WHERE id = ?
    `).get(checkId)!;

    expect(row.status).toBe("pending");
    expect(row.affected).toBeNull();
    expect(row.impact_type).toBeNull();
    expect(row.evidence_kind).toBeNull();
    expect(row.evidence).toBeNull();
    expect(row.confidence).toBeNull();
    expect(row.summary).toBeNull();
    expect(row.recommended_action).toBeNull();
    expect(row.checked_at).toBeNull();
    expect(row.alert_dispatched_at).toBeNull();
    expect(row.lark_message_id).toBeNull();
    expect(row.alert_card_json).toBeNull();
    expect(row.last_error).toBeNull();
    expect(row.retry_count).toBe(0);
    expect(row.alert_attempt_count).toBe(0);
  });

  it("works on complete status rows", () => {
    const result = requeueById(db, checkId, true);
    expect(result.mutated).toBe(true);
    expect(result.before!.status).toBe("complete");
    expect(result.after!.status).toBe("pending");
  });

  it("works on failed status rows", () => {
    const failedId = insertCheck(db, {
      targetProjectId: "mantle/op-geth",
      status: "failed",
      retryCount: 2,
      affected: null,
      checkedAt: null,
    });

    const result = requeueById(db, failedId, true);
    expect(result.mutated).toBe(true);
    expect(result.after!.status).toBe("pending");
    expect(result.after!.retry_count).toBe(0);
  });

  it("works on expired status rows", () => {
    const expiredId = insertCheck(db, {
      targetProjectId: "mantle/op-geth",
      status: "expired",
      affected: null,
      checkedAt: null,
      alertCardJson: null,
      larkMessageId: null,
      alertDispatchedAt: null,
      alertAttemptCount: 0,
    });

    const result = requeueById(db, expiredId, true);
    expect(result.mutated).toBe(true);
    expect(result.after!.status).toBe("pending");
  });

  it("works on skipped_budget status rows", () => {
    const skippedId = insertCheck(db, {
      targetProjectId: "mantle/op-geth",
      status: "skipped_budget",
      affected: null,
      checkedAt: null,
      alertCardJson: null,
      larkMessageId: null,
      alertDispatchedAt: null,
      alertAttemptCount: 0,
    });

    const result = requeueById(db, skippedId, true);
    expect(result.mutated).toBe(true);
    expect(result.after!.status).toBe("pending");
  });
});

// ---- requeueSkippedBudget ----

describe("requeueSkippedBudget — dry run", () => {
  let db: Database;

  beforeEach(() => {
    db = createDb();
  });

  it("returns before list without mutating when yes=false", () => {
    insertCheck(db, { status: "skipped_budget", affected: null, checkedAt: null, alertAttemptCount: 0 });
    insertCheck(db, { targetProjectId: "mantle/op-geth", status: "skipped_budget", affected: null, checkedAt: null, alertAttemptCount: 0 });

    const result = requeueSkippedBudget(db, false);

    expect(result.mutated).toBe(false);
    expect(result.before).toHaveLength(2);

    const rows = db.query<{ status: string }, []>("SELECT status FROM impact_checks").all();
    expect(rows.every((r) => r.status === "skipped_budget")).toBe(true);
  });

  it("returns empty list when no skipped_budget rows exist", () => {
    insertCheck(db);
    const result = requeueSkippedBudget(db, false);
    expect(result.before).toHaveLength(0);
  });
});

describe("requeueSkippedBudget — confirmed (--yes)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDb();
  });

  it("resets all skipped_budget rows to pending and clears retry_count", () => {
    insertCheck(db, { status: "skipped_budget", retryCount: 2, affected: null, checkedAt: null, alertAttemptCount: 0 });
    insertCheck(db, { targetProjectId: "mantle/op-geth", status: "skipped_budget", retryCount: 1, affected: null, checkedAt: null, alertAttemptCount: 0 });

    const result = requeueSkippedBudget(db, true);

    expect(result.mutated).toBe(true);
    expect(result.before).toHaveLength(2);
    expect(result.after).toHaveLength(0); // now they're pending, not skipped_budget

    const rows = db.query<{ status: string; retry_count: number }, []>(
      "SELECT status, retry_count FROM impact_checks ORDER BY id"
    ).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows.every((r) => r.retry_count === 0)).toBe(true);
  });

  it("does not touch complete or failed rows", () => {
    insertCheck(db, { status: "complete" });
    insertCheck(db, { targetProjectId: "mantle/op-geth", status: "skipped_budget", affected: null, checkedAt: null, alertAttemptCount: 0 });

    const result = requeueSkippedBudget(db, true);

    expect(result.mutated).toBe(true);
    expect(result.before).toHaveLength(1);

    const complete = db.query<{ status: string }, []>(
      "SELECT status FROM impact_checks WHERE target_project_id = 'mantle/reth'"
    ).get()!;
    expect(complete.status).toBe("complete");
  });

  it("returns mutated=false when no skipped_budget rows exist", () => {
    insertCheck(db, { status: "complete" });
    const result = requeueSkippedBudget(db, true);
    expect(result.mutated).toBe(false);
  });
});
