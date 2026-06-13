import type { Database } from "bun:sqlite";
import { getDb } from "../../storage/db";
import type { FlagValue, GlobalFlags } from "../args";
import { flagBool, flagString } from "../args";
import type { ImpactCheck } from "../../storage/schema";

const VERDICT_FIELDS = [
  "affected",
  "impact_type",
  "evidence_kind",
  "evidence",
  "confidence",
  "summary",
  "recommended_action",
  "checked_at",
  "alert_dispatched_at",
  "lark_message_id",
  "alert_card_json",
  "last_error",
] as const;

type RequeuedRow = Pick<
  ImpactCheck,
  | "id"
  | "pr_id"
  | "target_project_id"
  | "status"
  | "retry_count"
  | "alert_attempt_count"
  | "affected"
  | "checked_at"
>;

function selectById(db: Database, id: number): RequeuedRow | null {
  return (
    db
      .query<RequeuedRow, [number]>(
        `SELECT id, pr_id, target_project_id, status, retry_count, alert_attempt_count, affected, checked_at
         FROM impact_checks WHERE id = ?`
      )
      .get(id) ?? null
  );
}

function selectSkippedBudget(db: Database): RequeuedRow[] {
  return db
    .query<RequeuedRow, []>(
      `SELECT id, pr_id, target_project_id, status, retry_count, alert_attempt_count, affected, checked_at
       FROM impact_checks WHERE status = 'skipped_budget'`
    )
    .all();
}

export interface RequeueByIdResult {
  mutated: boolean;
  before: RequeuedRow | null;
  after: RequeuedRow | null;
}

export interface RequeueSkippedBudgetResult {
  mutated: boolean;
  before: RequeuedRow[];
  after: RequeuedRow[];
}

export function requeueById(
  db: Database,
  id: number,
  yes: boolean
): RequeueByIdResult {
  const before = selectById(db, id);
  if (!before) return { mutated: false, before: null, after: null };

  if (!yes) {
    return { mutated: false, before, after: before };
  }

  db.query(`
    UPDATE impact_checks SET
      status = 'pending',
      retry_count = 0,
      alert_attempt_count = 0,
      affected = NULL,
      impact_type = NULL,
      evidence_kind = NULL,
      evidence = NULL,
      confidence = NULL,
      summary = NULL,
      recommended_action = NULL,
      checked_at = NULL,
      alert_dispatched_at = NULL,
      lark_message_id = NULL,
      alert_card_json = NULL,
      last_error = NULL
    WHERE id = ?
  `).run(id);

  const after = selectById(db, id);
  return { mutated: true, before, after };
}

export function requeueSkippedBudget(
  db: Database,
  yes: boolean
): RequeueSkippedBudgetResult {
  const before = selectSkippedBudget(db);
  if (!yes) {
    return { mutated: false, before, after: before };
  }

  if (before.length === 0) {
    return { mutated: false, before, after: before };
  }

  db.query(`
    UPDATE impact_checks SET
      status = 'pending',
      retry_count = 0
    WHERE status = 'skipped_budget'
  `).run();

  const after = selectSkippedBudget(db);
  return { mutated: true, before, after };
}

export async function impactCheckRequeueCommand(
  _rest: string[],
  flags: Record<string, FlagValue>,
  _global: GlobalFlags = { json: false, verbose: false }
): Promise<number> {
  const yes = flagBool(flags, "yes");
  const idRaw = flagString(flags, "id");
  const skippedBudget = flagBool(flags, "skipped-budget");

  if (!idRaw && !skippedBudget) {
    console.error("[impact-check requeue] Either --id <checkId> or --skipped-budget is required.");
    return 1;
  }

  if (idRaw && skippedBudget) {
    console.error("[impact-check requeue] --id and --skipped-budget are mutually exclusive.");
    return 1;
  }

  const db = getDb();

  if (idRaw) {
    const id = parseInt(idRaw, 10);
    if (!Number.isInteger(id) || id <= 0) {
      console.error(`[impact-check requeue] --id must be a positive integer (got: ${idRaw})`);
      return 1;
    }

    const result = requeueById(db, id, yes);

    if (!result.before) {
      console.error(`[impact-check requeue] No impact_check found with id=${id}`);
      return 1;
    }

    console.log(`[impact-check requeue] Check #${id} — ${result.before.target_project_id}`);
    console.log(`[impact-check requeue] Before: status=${result.before.status} retry_count=${result.before.retry_count} affected=${result.before.affected ?? "null"} checked_at=${result.before.checked_at ?? "null"}`);

    if (!yes) {
      console.log("[impact-check requeue] Dry run. Re-run with --yes to reset status and clear verdict fields.");
      return 0;
    }

    console.log(`[impact-check requeue] After: status=${result.after?.status ?? "?"} retry_count=${result.after?.retry_count ?? "?"} affected=${result.after?.affected ?? "null"} checked_at=${result.after?.checked_at ?? "null"}`);
    return 0;
  }

  // --skipped-budget
  const result = requeueSkippedBudget(db, yes);

  console.log(`[impact-check requeue] Found ${result.before.length} skipped_budget row(s)`);
  for (const row of result.before) {
    console.log(`  #${row.id} pr_id=${row.pr_id} target=${row.target_project_id} retry_count=${row.retry_count}`);
  }

  if (!yes) {
    console.log("[impact-check requeue] Dry run. Re-run with --yes to reset skipped_budget rows to pending.");
    return 0;
  }

  if (result.before.length === 0) {
    console.log("[impact-check requeue] No skipped_budget rows to reset.");
    return 0;
  }

  console.log(`[impact-check requeue] Reset ${result.before.length} row(s) to pending.`);
  return 0;
}
