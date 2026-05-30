import { readFileSync, renameSync, mkdirSync, unlinkSync } from "fs";
import { randomUUID } from "crypto";
import type { PipelineContext, PipelineStage, StageResult } from "../runner";
import { getDb } from "../../storage/db";
import { getSettings } from "../../config/settings";
import { truncateDiff } from "../../extensions/analyzer/diff-truncator";
import { reviewPR } from "../../extensions/analyzer/llm-reviewer";
import { buildProjectContext } from "../../extensions/analyzer/context";
import type { AnalysisContext } from "../../extensions/analyzer/context";

const TMP_DIR = "data/analysis-inputs/tmp";
const FINAL_DIR = "data/analysis-inputs";

function getMonthStart(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
}

interface PRRow {
  id: number;
  project_id: string;
  title: string;
  author: string | null;
  body: string | null;
  files_changed: number | null;
  additions: number | null;
  deletions: number | null;
  diff_path: string | null;
  diff_status: string;
  description: string | null;
  language: string | null;
  topics: string | null;
  overview: string | null;
}

export async function buildAnalysisContext(row: PRRow): Promise<AnalysisContext> {
  const settings = getSettings();
  const projectContext = buildProjectContext(row);

  const hasDiff =
    row.diff_status === "available" && row.diff_path !== null;

  if (!hasDiff) {
    return {
      diff: null,
      supplementaryContext: null,
      projectContext,
      inputQuality: "metadata_only",
    };
  }

  try {
    const rawDiff = readFileSync(row.diff_path!, "utf-8");
    const truncated = truncateDiff(
      rawDiff,
      settings.llm.diffTokenBudget,
      settings.llm.maxManifestEntries
    );
    return {
      diff: truncated,
      supplementaryContext: null,
      projectContext,
      inputQuality: "diff_aware",
    };
  } catch {
    return {
      diff: null,
      supplementaryContext: null,
      projectContext,
      inputQuality: "metadata_only",
    };
  }
}

export async function execute(_ctx: PipelineContext): Promise<StageResult> {
  const db = getDb();
  const settings = getSettings();
  const errors: string[] = [];
  let itemsProcessed = 0;
  let budgetExhausted = false;
  let budgetSkippedCount = 0;

  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(FINAL_DIR, { recursive: true });

  const pendingPRs = db
    .query<PRRow, []>(
      `SELECT pr.*, p.description, p.language, p.topics, p.overview
       FROM pull_requests pr JOIN projects p ON pr.project_id = p.id
       WHERE pr.analysis_status = 'pending'
          OR (pr.analysis_status = 'failed' AND pr.retry_count < 3)`
    )
    .all();

  console.log(`[Analyze] Found ${pendingPRs.length} PRs to analyze`);

  const monthStart = getMonthStart();

  let prIndex = 0;
  for (const pr of pendingPRs) {
    prIndex++;

    // Budget check before each PR
    const budgetRow = db
      .query<{ total_cost: number | null }, [string]>(
        `SELECT SUM(estimated_cost_usd) as total_cost FROM analyses WHERE analyzed_at >= unixepoch(?)`
      )
      .get(monthStart);
    const monthlySpend = budgetRow?.total_cost ?? 0;

    if (monthlySpend >= settings.budget.monthlyCap) {
      const remaining = pendingPRs.length - prIndex + 1;
      console.warn(
        `[Analyze] Monthly budget cap ($${settings.budget.monthlyCap}) reached. Skipping remaining ${remaining} PRs.`
      );
      budgetExhausted = true;
      budgetSkippedCount = remaining;
      break;
    }

    try {
      const ctx = await buildAnalysisContext(pr);
      const runId = randomUUID();

      // Step 1: write truncated diff to tmp file
      const tmpPath = `${TMP_DIR}/${pr.id}-${runId}.diff.tmp`;
      const diffContent = ctx.diff?.content ?? "";
      try {
        await Bun.write(tmpPath, diffContent);
      } catch (writeErr) {
        const msg = `PR ${pr.id}: failed to write tmp diff: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`;
        console.error(`[Analyze] ${msg}`);
        errors.push(msg);
        db.run(
          `UPDATE pull_requests SET analysis_status = 'failed', retry_count = retry_count + 1, last_error = ? WHERE id = ?`,
          [msg, pr.id]
        );
        continue;
      }

      // Step 2: LLM call
      let reviewResult;
      try {
        reviewResult = await reviewPR(ctx, pr);
      } catch (llmErr) {
        const msg = `PR ${pr.id}: LLM error: ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`;
        console.error(`[Analyze] ${msg}`);
        errors.push(msg);
        db.run(
          `UPDATE pull_requests SET analysis_status = 'failed', retry_count = retry_count + 1, last_error = ? WHERE id = ?`,
          [msg, pr.id]
        );
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
        continue;
      }

      // Step 3: Atomic DB transaction — insert analyses + analysis_inputs
      let analysisId: number;
      try {
        const categoriesJson = JSON.stringify(reviewResult.output.categories);
        const finalDiffPath = `${FINAL_DIR}/_PLACEHOLDER_.diff`; // replaced after we have analysis_id

        const insertResult = db.transaction(() => {
          db.run(
            `INSERT INTO analyses
               (pr_id, project_id, summary, technical_detail, direction_signal,
                significance, categories, model_id, input_tokens, output_tokens,
                estimated_cost_usd)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              pr.id,
              pr.project_id,
              reviewResult.output.summary,
              reviewResult.output.technical_detail,
              reviewResult.output.direction_signal,
              reviewResult.output.significance,
              categoriesJson,
              settings.llm.model,
              reviewResult.inputTokens,
              reviewResult.outputTokens,
              reviewResult.estimatedCostUsd,
            ]
          );

          const inserted = db
            .query<{ id: number }, []>("SELECT last_insert_rowid() as id")
            .get()!;
          const aid = inserted.id;

          const diffPath = `${FINAL_DIR}/${aid}.diff`;

          db.run(
            `INSERT INTO analysis_inputs
               (analysis_id, prompt_version, input_quality, rendered_project_context,
                file_manifest, diff_included_files, diff_total_files, diff_truncated,
                truncated_diff_path)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              aid,
              reviewResult.promptVersion,
              reviewResult.inputQuality,
              reviewResult.renderedProjectContext,
              reviewResult.fileManifest,
              reviewResult.diffIncludedFiles,
              reviewResult.diffTotalFiles,
              reviewResult.diffTruncated ? 1 : 0,
              diffPath,
            ]
          );

          return { aid, diffPath };
        })();

        analysisId = insertResult.aid;
        const finalPath = insertResult.diffPath;

        // Step 4: rename tmp → final
        try {
          renameSync(tmpPath, finalPath);
        } catch (renameErr) {
          // Mark truncated_diff_path as NULL if rename fails
          console.error(`[Analyze] PR ${pr.id}: rename failed: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`);
          db.run(
            `UPDATE analysis_inputs SET truncated_diff_path = NULL WHERE analysis_id = ?`,
            [analysisId]
          );
        }

        db.run(`UPDATE pull_requests SET analysis_status = 'complete' WHERE id = ?`, [pr.id]);
        itemsProcessed++;
        console.log(
          `[Analyze] PR ${pr.id} (${pr.title}): ${reviewResult.output.significance}, cost $${reviewResult.estimatedCostUsd.toFixed(4)}`
        );
      } catch (dbErr) {
        const msg = `PR ${pr.id}: DB transaction failed: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`;
        console.error(`[Analyze] ${msg}`);
        errors.push(msg);
        db.run(
          `UPDATE pull_requests SET analysis_status = 'failed', retry_count = retry_count + 1, last_error = ? WHERE id = ?`,
          [msg, pr.id]
        );
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    } catch (err) {
      const msg = `PR ${pr.id}: unexpected error: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[Analyze] ${msg}`);
      errors.push(msg);
      db.run(
        `UPDATE pull_requests SET analysis_status = 'failed', retry_count = retry_count + 1, last_error = ? WHERE id = ?`,
        [msg, pr.id]
      );
    }
  }

  return {
    success: errors.length === 0 && !budgetExhausted,
    itemsProcessed,
    errors,
    durationMs: 0,
    budgetExhausted,
    budgetSkippedCount,
  };
}

export const stage: PipelineStage = {
  name: "analyze",
  execute,
};
