import { readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { PipelineContext, PipelineStage, StageResult } from "../runner";
import { getDb } from "../../storage/db";
import { getSettings } from "../../config/settings";
import { reloadMantleConfig } from "../../config/projects";
import type { CounterpartRelationship, MantleConfig, MantleTarget } from "../../config/projects";
import { processQueue, getPendingQueue, upsertImpactChecks } from "../../extensions/impact-checker/index";
import type { PendingRow, GateInput } from "../../extensions/impact-checker/index";
import { syncTarget } from "../../extensions/impact-checker/clone-manager";
import type { CloneSyncState, CloneManagerOptions } from "../../extensions/impact-checker/clone-manager";
import { runImpactCheck } from "../../extensions/impact-checker/checker";
import type { CheckerInput, ImpactCheckVerdict } from "../../extensions/impact-checker/checker";
import { renderAlertCard } from "../../extensions/impact-checker/alert-card";
import { sendCard } from "../../extensions/lark-dispatcher/webhook";
import type { LarkWebhookResponse } from "../../extensions/lark-dispatcher/webhook";

type ImpactRelationship = "fork_of" | "depends_on" | "protocol_dependency";

interface GateInputRow {
  id: number;
  pr_id: number;
  project_id: string;
  merged_at: number | null;
  significance: string | null;
  downstream_impact_hint: string | null;
}

interface PRAnalysisRow {
  title: string;
  body: string | null;
  diff_status: string;
  diff_path: string | null;
  summary: string;
  technical_detail: string | null;
  pr_number: number;
  project_id: string;
}

export interface ImpactCheckStageDeps {
  getSettingsFn?: typeof getSettings;
  getDbFn?: () => Database;
  upsertImpactChecksFn?: typeof upsertImpactChecks;
  processQueueFn?: typeof processQueue;
  syncTargetFn?: typeof syncTarget;
  runImpactCheckFn?: typeof runImpactCheck;
  sendCardFn?: (webhookUrl: string, card: object) => Promise<LarkWebhookResponse>;
}

function findMantleTarget(mantleConfig: MantleConfig, projectId: string): MantleTarget | undefined {
  return mantleConfig.mantleTargets.find((t) => t.projectId === projectId);
}

function findRelationship(
  mantleConfig: MantleConfig,
  sourceProjectId: string,
  targetProjectId: string,
  relationship: ImpactRelationship
): CounterpartRelationship | undefined {
  return mantleConfig.counterpartRelationships.find(
    (rel) =>
      rel.source === sourceProjectId &&
      rel.relationship === relationship &&
      rel.targets.includes(targetProjectId)
  );
}

function readDiffRaw(diffPath: string | null): string | null {
  if (!diffPath) return null;
  try {
    return readFileSync(diffPath, "utf-8");
  } catch {
    return null;
  }
}

function mapDiffStatus(dbStatus: string): "available" | "unavailable" | "too_large" {
  if (dbStatus === "available") return "available";
  if (dbStatus === "too_large") return "too_large";
  return "unavailable";
}

async function syncUniqueTargets(
  pendingRows: PendingRow[],
  mantleConfig: MantleConfig,
  cloneOpts: CloneManagerOptions,
  syncTargetFn: typeof syncTarget
): Promise<Map<string, CloneSyncState>> {
  const uniqueTargetIds = [...new Set(pendingRows.map((r) => r.target_project_id))];
  const cloneStates = new Map<string, CloneSyncState>();

  for (const targetId of uniqueTargetIds) {
    const mantleTarget = findMantleTarget(mantleConfig, targetId);
    if (!mantleTarget?.repoUrl) {
      console.warn(`[ImpactCheck] No repoUrl for target ${targetId} — skipping clone sync`);
      continue;
    }
    try {
      const state = await syncTargetFn(mantleTarget, cloneOpts);
      cloneStates.set(targetId, state);
    } catch (err) {
      console.warn(
        `[ImpactCheck] syncTarget failed for ${targetId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return cloneStates;
}

function writeVerdictSuccess(
  db: Database,
  rowId: number,
  verdict: ImpactCheckVerdict,
  commitHash: string,
  alertCardJson: string | null
): void {
  db.query(`
    UPDATE impact_checks SET
      status = 'complete',
      affected = ?,
      impact_type = ?,
      evidence_kind = ?,
      evidence = ?,
      confidence = ?,
      summary = ?,
      recommended_action = ?,
      target_commit = ?,
      input_tokens = ?,
      estimated_cost_usd = ?,
      tool_steps = ?,
      alert_card_json = ?,
      checked_at = unixepoch()
    WHERE id = ?
  `).run(
    verdict.affected,
    verdict.impactType,
    verdict.evidenceKind,
    JSON.stringify(verdict.evidence),
    verdict.confidence,
    verdict.summary,
    verdict.recommendedAction,
    commitHash,
    verdict.tokensUsed,
    verdict.cost,
    verdict.toolSteps,
    alertCardJson,
    rowId
  );
}

function writeVerdictError(db: Database, rowId: number, error: string): void {
  db.query(`
    UPDATE impact_checks SET
      status = 'failed',
      retry_count = retry_count + 1,
      last_error = ?,
      checked_at = unixepoch()
    WHERE id = ?
  `).run(error, rowId);
}

export async function execute(ctx: PipelineContext, deps?: ImpactCheckStageDeps): Promise<StageResult> {
  const stageStart = Date.now();
  const settings = (deps?.getSettingsFn ?? getSettings)();

  if (settings.impactCheck?.enabled !== true) {
    return { success: true, itemsProcessed: 0, errors: [], durationMs: 0 };
  }

  try {
    const db = (deps?.getDbFn ?? getDb)();
    const { config: mantleConfig } = reloadMantleConfig();
    const impactCheckConfig = settings.impactCheck;

    const upsertImpactChecksFn = deps?.upsertImpactChecksFn ?? upsertImpactChecks;
    const processQueueFn = deps?.processQueueFn ?? processQueue;
    const syncTargetFn = deps?.syncTargetFn ?? syncTarget;
    const runImpactCheckFn = deps?.runImpactCheckFn ?? runImpactCheck;
    const sendCardFn = deps?.sendCardFn ?? sendCard;

    // 1. Enqueue new analyses as pending impact_checks rows
    const gateInputCutoffUnix =
      Math.floor(Date.now() / 1000) - Math.max(0, impactCheckConfig.maxAgeDays) * 86400;
    const gateInputRows = db.query<GateInputRow, [number]>(`
      SELECT a.id, a.pr_id, pr.project_id, pr.merged_at,
             a.significance, a.downstream_impact_hint
      FROM analyses a
      JOIN pull_requests pr ON a.pr_id = pr.id
      WHERE pr.merged_at >= ?
    `).all(gateInputCutoffUnix);

    const gateInputs: GateInput[] = gateInputRows.map((r) => ({
      prId: r.pr_id,
      analysisId: r.id,
      projectId: r.project_id,
      mergedAt: r.merged_at,
      significance: r.significance as GateInput["significance"],
      downstreamImpactHint: r.downstream_impact_hint as GateInput["downstreamImpactHint"],
    }));

    upsertImpactChecksFn(db, gateInputs, mantleConfig, impactCheckConfig);

    // 2. Queue governance: expire stale rows, revive failed rows, budget shutdown
    processQueueFn(db, impactCheckConfig);

    // Snapshot post-governance counts for StageResult fields
    const budgetSkippedCount = db.query<{ cnt: number }, []>(
      "SELECT COUNT(*) as cnt FROM impact_checks WHERE status = 'skipped_budget'"
    ).get()!.cnt;
    const expiredCount = db.query<{ cnt: number }, []>(
      "SELECT COUNT(*) as cnt FROM impact_checks WHERE status = 'expired'"
    ).get()!.cnt;
    const deadLetteredCount = db.query<{ cnt: number }, []>(
      "SELECT COUNT(*) as cnt FROM impact_checks WHERE alert_card_json IS NOT NULL AND alert_dispatched_at IS NULL AND alert_attempt_count >= 5"
    ).get()!.cnt;
    const totalPendingCount = db.query<{ cnt: number }, []>(
      "SELECT COUNT(*) as cnt FROM impact_checks WHERE status = 'pending'"
    ).get()!.cnt;

    // 3. Get pending queue ordered by priority
    const pendingRows = getPendingQueue(db, impactCheckConfig);
    const quotaSkipped = Math.max(0, totalPendingCount - pendingRows.length);

    if (pendingRows.length === 0) {
      return {
        success: true,
        itemsProcessed: 0,
        errors: [],
        durationMs: Date.now() - stageStart,
        impactChecksRun: 0,
        impactAlertsSent: 0,
        impactChecksSkipped: { budget: budgetSkippedCount, quota: quotaSkipped, clone_failure: 0 },
        impactChecksExpired: expiredCount,
        impactAlertsDeadLettered: deadLetteredCount,
      };
    }

    // 4. Clone sync — once per unique target_project_id
    const cloneOpts: CloneManagerOptions = {
      clonesDir: impactCheckConfig.clonesDir,
      maxCloneDiskGB: impactCheckConfig.maxCloneDiskGB,
    };
    const cloneStates = await syncUniqueTargets(pendingRows, mantleConfig, cloneOpts, syncTargetFn);

    // 5. Process pending rows serially
    let itemsProcessed = 0;
    let cloneFailureSkipped = 0;

    for (const row of pendingRows) {
      const cloneState = cloneStates.get(row.target_project_id);
      if (!cloneState?.available) {
        cloneFailureSkipped++;
        console.warn(`[ImpactCheck] Clone not available for ${row.target_project_id} — skipping row ${row.id}`);
        continue;
      }

      const mantleTarget = findMantleTarget(mantleConfig, row.target_project_id);
      if (!mantleTarget) {
        console.warn(`[ImpactCheck] No MantleTarget for ${row.target_project_id} — skipping row ${row.id}`);
        continue;
      }

      const prAnalysis = db
        .query<PRAnalysisRow, [number, number]>(
          `SELECT pr.title, pr.body, pr.diff_status, pr.diff_path,
                  a.summary, a.technical_detail,
                  pr.pr_number, pr.project_id
           FROM pull_requests pr
           JOIN analyses a ON a.pr_id = pr.id AND a.id = ?
           WHERE pr.id = ?`
        )
        .get(row.analysis_id, row.pr_id);

      if (!prAnalysis) {
        console.warn(`[ImpactCheck] PR/analysis data not found for row ${row.id} — skipping`);
        continue;
      }

      const relationship = findRelationship(
        mantleConfig,
        prAnalysis.project_id,
        row.target_project_id,
        row.relationship
      );
      if (!relationship) {
        console.warn(
          `[ImpactCheck] No relationship for ${prAnalysis.project_id} -> ${row.target_project_id}/${row.relationship} — skipping row ${row.id}`
        );
        continue;
      }

      const diffStatus = mapDiffStatus(prAnalysis.diff_status);
      const diffRaw = diffStatus === "available" ? readDiffRaw(prAnalysis.diff_path) : null;

      const checkerInput: CheckerInput = {
        checkId: String(row.id),
        target: mantleTarget,
        relationship,
        cloneState: {
          cloneDir: cloneState.cloneDir,
          commitHash: cloneState.commitHash,
          lastFetchAt: cloneState.lastFetchAt,
        },
        upstreamPR: {
          title: prAnalysis.title,
          body: prAnalysis.body,
          diffRaw,
          diffStatus,
        },
        analyzerSummary: prAnalysis.summary
          ? { summary: prAnalysis.summary, technicalDetail: prAnalysis.technical_detail ?? "" }
          : null,
      };

      try {
        const verdict = await runImpactCheckFn(checkerInput);

        const alertCardJson = renderAlertCard({
          checkId: row.id,
          verdict,
          prNumber: prAnalysis.pr_number,
          prTitle: prAnalysis.title,
          sourceProjectId: prAnalysis.project_id,
          targetProjectId: row.target_project_id,
          targetCommit: cloneState.commitHash,
          checkedAt: new Date().toISOString().slice(0, 10),
        });

        // Write verdict + alert_card_json atomically in one UPDATE
        writeVerdictSuccess(db, row.id, verdict, cloneState.commitHash, alertCardJson);
        itemsProcessed++;
        console.log(
          `[ImpactCheck] Completed check ${row.id}: affected=${verdict.affected} confidence=${verdict.confidence}`
        );

        // In-stage first send (only when card was rendered)
        if (alertCardJson !== null) {
          const dispatchEnabled = ctx.dispatchEnabled !== false;
          const webhookUrl = settings.lark?.webhookUrl;

          if (!dispatchEnabled || !webhookUrl) {
            console.log(`[ImpactCheck] Alert card stored for check ${row.id} (dispatch suppressed)`);
          } else {
            const card = JSON.parse(alertCardJson) as object;
            try {
              const sendResult = await sendCardFn(webhookUrl, card);
              if (sendResult.code === 0) {
                db.query(`
                  UPDATE impact_checks SET
                    alert_dispatched_at = unixepoch(),
                    lark_message_id = ?,
                    alert_attempt_count = alert_attempt_count + 1
                  WHERE id = ?
                `).run(sendResult.data?.message_id ?? null, row.id);
                console.log(
                  `[ImpactCheck] Alert card sent for check ${row.id} (msg_id=${sendResult.data?.message_id ?? "n/a"})`
                );
              } else {
                db.query(
                  "UPDATE impact_checks SET alert_attempt_count = alert_attempt_count + 1 WHERE id = ?"
                ).run(row.id);
                console.warn(
                  `[ImpactCheck] Alert card send failed for check ${row.id}: code=${sendResult.code} msg=${sendResult.msg}`
                );
              }
            } catch (err) {
              db.query(
                "UPDATE impact_checks SET alert_attempt_count = alert_attempt_count + 1 WHERE id = ?"
              ).run(row.id);
              console.warn(
                `[ImpactCheck] Alert card send threw for check ${row.id}: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`[ImpactCheck] Check ${row.id} failed: ${error}`);
        writeVerdictError(db, row.id, error);
      }
    }

    const todayStart = Math.floor(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) / 1000
    );
    const checksRun = db.query<{ cnt: number }, [number]>(
      "SELECT COUNT(*) as cnt FROM impact_checks WHERE checked_at IS NOT NULL AND checked_at >= ?"
    ).get(todayStart)!.cnt;
    const alertsSent = db.query<{ cnt: number }, [number]>(
      "SELECT COUNT(*) as cnt FROM impact_checks WHERE alert_dispatched_at IS NOT NULL AND checked_at >= ?"
    ).get(todayStart)!.cnt;
    const finalDeadLettered = db.query<{ cnt: number }, []>(
      "SELECT COUNT(*) as cnt FROM impact_checks WHERE alert_card_json IS NOT NULL AND alert_dispatched_at IS NULL AND alert_attempt_count >= 5"
    ).get()!.cnt;

    return {
      success: true,
      itemsProcessed,
      errors: [],
      durationMs: Date.now() - stageStart,
      impactChecksRun: checksRun,
      impactAlertsSent: alertsSent,
      impactChecksSkipped: { budget: budgetSkippedCount, quota: quotaSkipped, clone_failure: cloneFailureSkipped },
      impactChecksExpired: expiredCount,
      impactAlertsDeadLettered: finalDeadLettered,
    };
  } catch (err) {
    const durationMs = Date.now() - stageStart;
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[ImpactCheck] Stage error: ${error}`);
    return { success: false, itemsProcessed: 0, errors: [error], durationMs };
  }
}

export const stage: PipelineStage = {
  name: "impact-check",
  execute: (ctx: PipelineContext) => execute(ctx),
};
