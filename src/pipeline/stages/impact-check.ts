import { readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { PipelineContext, PipelineStage, StageResult } from "../runner";
import { getDb } from "../../storage/db";
import { getSettings } from "../../config/settings";
import { reloadMantleConfig } from "../../config/projects";
import type { CounterpartRelationship, MantleConfig, MantleTarget } from "../../config/projects";
import { processQueue, getPendingQueue } from "../../extensions/impact-checker/index";
import type { PendingRow } from "../../extensions/impact-checker/index";
import { syncTarget } from "../../extensions/impact-checker/clone-manager";
import type { CloneSyncState, CloneManagerOptions } from "../../extensions/impact-checker/clone-manager";
import { runImpactCheck } from "../../extensions/impact-checker/checker";
import type { CheckerInput, ImpactCheckVerdict } from "../../extensions/impact-checker/checker";

type ImpactRelationship = "fork_of" | "depends_on" | "protocol_dependency";

interface PRAnalysisRow {
  title: string;
  body: string | null;
  diff_status: string;
  diff_path: string | null;
  summary: string;
  technical_detail: string | null;
}

export interface ImpactCheckStageDeps {
  getSettingsFn?: typeof getSettings;
  getDbFn?: () => Database;
  processQueueFn?: typeof processQueue;
  syncTargetFn?: typeof syncTarget;
  runImpactCheckFn?: typeof runImpactCheck;
}

function findMantleTarget(mantleConfig: MantleConfig, projectId: string): MantleTarget | undefined {
  return mantleConfig.mantleTargets.find((t) => t.projectId === projectId);
}

function findRelationship(
  mantleConfig: MantleConfig,
  targetProjectId: string,
  relationship: ImpactRelationship
): CounterpartRelationship | undefined {
  return mantleConfig.counterpartRelationships.find(
    (rel) => rel.relationship === relationship && rel.targets.includes(targetProjectId)
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
  commitHash: string
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
    rowId
  );
}

function writeVerdictError(db: Database, rowId: number, error: string): void {
  db.query(`
    UPDATE impact_checks SET
      status = 'failed',
      retry_count = retry_count + 1,
      last_error = ?
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

    const processQueueFn = deps?.processQueueFn ?? processQueue;
    const syncTargetFn = deps?.syncTargetFn ?? syncTarget;
    const runImpactCheckFn = deps?.runImpactCheckFn ?? runImpactCheck;

    // 1. Queue governance: expire stale rows, revive failed rows, budget shutdown
    processQueueFn(db, impactCheckConfig);

    // 2. Get pending queue ordered by priority
    const pendingRows = getPendingQueue(db, impactCheckConfig);
    if (pendingRows.length === 0) {
      return { success: true, itemsProcessed: 0, errors: [], durationMs: Date.now() - stageStart };
    }

    // 3. Clone sync — once per unique target_project_id
    const cloneOpts: CloneManagerOptions = {
      clonesDir: impactCheckConfig.clonesDir,
      maxCloneDiskGB: impactCheckConfig.maxCloneDiskGB,
    };
    const cloneStates = await syncUniqueTargets(pendingRows, mantleConfig, cloneOpts, syncTargetFn);

    // 4. Process pending rows serially
    let itemsProcessed = 0;

    for (const row of pendingRows) {
      const cloneState = cloneStates.get(row.target_project_id);
      if (!cloneState?.available) {
        console.warn(`[ImpactCheck] Clone not available for ${row.target_project_id} — skipping row ${row.id}`);
        continue;
      }

      const mantleTarget = findMantleTarget(mantleConfig, row.target_project_id);
      if (!mantleTarget) {
        console.warn(`[ImpactCheck] No MantleTarget for ${row.target_project_id} — skipping row ${row.id}`);
        continue;
      }

      const relationship = findRelationship(mantleConfig, row.target_project_id, row.relationship);
      if (!relationship) {
        console.warn(
          `[ImpactCheck] No relationship for ${row.target_project_id}/${row.relationship} — skipping row ${row.id}`
        );
        continue;
      }

      const prAnalysis = db
        .query<PRAnalysisRow, [number, number]>(
          `SELECT pr.title, pr.body, pr.diff_status, pr.diff_path,
                  a.summary, a.technical_detail
           FROM pull_requests pr
           JOIN analyses a ON a.pr_id = pr.id AND a.id = ?
           WHERE pr.id = ?`
        )
        .get(row.analysis_id, row.pr_id);

      if (!prAnalysis) {
        console.warn(`[ImpactCheck] PR/analysis data not found for row ${row.id} — skipping`);
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
        writeVerdictSuccess(db, row.id, verdict, cloneState.commitHash);
        itemsProcessed++;
        console.log(
          `[ImpactCheck] Completed check ${row.id}: affected=${verdict.affected} confidence=${verdict.confidence}`
        );
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`[ImpactCheck] Check ${row.id} failed: ${error}`);
        writeVerdictError(db, row.id, error);
      }
    }

    return { success: true, itemsProcessed, errors: [], durationMs: Date.now() - stageStart };
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
