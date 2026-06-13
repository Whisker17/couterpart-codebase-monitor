import type { PipelineContext, PipelineStage, StageResult } from "../runner";
import { getDb } from "../../storage/db";
import { getSettings } from "../../config/settings";
import { reloadMantleConfig } from "../../config/projects";
import { upsertImpactChecks, processQueue, type GateInput } from "../../extensions/impact-checker/index";

type Significance = "routine" | "notable" | "directional_shift";
type DownstreamImpactHint = "none" | "possible" | "likely";

interface AnalysisRow {
  analysis_id: number;
  pr_id: number;
  project_id: string;
  significance: Significance | null;
  downstream_impact_hint: DownstreamImpactHint | null;
  merged_at: number | null;
}

export async function execute(_ctx: PipelineContext): Promise<StageResult> {
  const stageStart = Date.now();
  const settings = getSettings();

  if (settings.impactCheck?.enabled !== true) {
    return { success: true, itemsProcessed: 0, errors: [], durationMs: 0 };
  }

  try {
    const db = getDb();
    const { config: mantleConfig } = reloadMantleConfig();
    const impactCheckConfig = settings.impactCheck;

    // Query analyses within the maxAgeDays window to build the upsert input list.
    const cutoff = Math.floor(Date.now() / 1000) - impactCheckConfig.maxAgeDays * 86400;
    const analyses = db
      .query<AnalysisRow, [number]>(
        `SELECT a.id as analysis_id, a.pr_id, a.project_id, a.significance,
                a.downstream_impact_hint, pr.merged_at
         FROM analyses a
         JOIN pull_requests pr ON a.pr_id = pr.id
         WHERE pr.merged_at >= ?
         ORDER BY pr.merged_at DESC`
      )
      .all(cutoff);

    const inputs: GateInput[] = analyses.map((row) => ({
      prId: row.pr_id,
      analysisId: row.analysis_id,
      projectId: row.project_id,
      significance: row.significance,
      downstreamImpactHint: row.downstream_impact_hint,
      mergedAt: row.merged_at,
    }));

    const upserted = upsertImpactChecks(db, inputs, mantleConfig, impactCheckConfig);
    console.log(`[ImpactCheck] Upserted ${upserted} impact check row(s) from ${analyses.length} analyses`);

    const stats = processQueue(db, impactCheckConfig);
    console.log(
      `[ImpactCheck] Queue governance: expired=${stats.expired} revived=${stats.revived} skippedBudget=${stats.skippedBudget}`
    );

    const itemsProcessed = stats.expired + stats.revived + stats.skippedBudget;

    return {
      success: true,
      itemsProcessed,
      errors: [],
      durationMs: 0,
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
  execute,
};
