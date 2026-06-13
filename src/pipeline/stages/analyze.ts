import { readFileSync, renameSync, mkdirSync, unlinkSync, readdirSync, statSync } from "fs";
import { randomUUID } from "crypto";
import type { PipelineContext, PipelineStage, StageResult } from "../runner";
import { getDb } from "../../storage/db";
import { getSettings } from "../../config/settings";
import { truncateDiff } from "../../extensions/analyzer/diff-truncator";
import { reviewPR } from "../../extensions/analyzer/llm-reviewer";
import { buildProjectContext } from "../../extensions/analyzer/context";
import type { AnalysisContext } from "../../extensions/analyzer/context";
import { getBudgetStatus } from "../../utils/budget-tracker";
import { preFilterSignificance } from "../../extensions/analyzer/significance";
import { sendCard } from "../../extensions/lark-dispatcher/webhook";

const TMP_DIR = "data/analysis-inputs/tmp";
const FINAL_DIR = "data/analysis-inputs";
const IMPACT_CHECKS_DIR = "data/impact-checks";

function buildBudgetAlertCard(estimatedCost: number, budgetCap: number): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "Counterpart Monitor · Budget Alert" },
      template: "red",
    },
    elements: [
      {
        tag: "markdown",
        content: `**Budget alert: $${estimatedCost.toFixed(2)}/$${budgetCap.toFixed(2)} used. Analysis paused.**`,
      },
    ],
  };
}

export interface AnalyzeOptions {
  dateRange?: { startUnix: number; endUnix: number };
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

function cleanupStaleTmpFiles(): void {
  try {
    const files = readdirSync(TMP_DIR).filter((f) => f.endsWith(".diff.tmp"));
    for (const f of files) {
      try { unlinkSync(`${TMP_DIR}/${f}`); } catch { /* ignore */ }
    }
    if (files.length > 0) {
      console.warn(`[Analyze] Cleaned up ${files.length} stale tmp diff file(s) from previous run`);
    }
  } catch {
    // TMP_DIR may not exist yet — that's fine
  }
}

function cleanupStaleImpactCheckFiles(maxAgeDays: number): void {
  try {
    const files = readdirSync(IMPACT_CHECKS_DIR).filter((f) => f.endsWith(".jsonl"));
    const cutoffMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let removed = 0;
    for (const f of files) {
      try {
        const stat = statSync(`${IMPACT_CHECKS_DIR}/${f}`);
        if (now - stat.mtimeMs > cutoffMs) {
          unlinkSync(`${IMPACT_CHECKS_DIR}/${f}`);
          removed++;
        }
      } catch { /* ignore individual file errors */ }
    }
    if (removed > 0) {
      console.info(`[Analyze] Cleaned up ${removed} expired impact-check JSONL file(s) (older than ${maxAgeDays} days)`);
    }
  } catch {
    // IMPACT_CHECKS_DIR may not exist yet — that's fine
  }
}

export async function execute(_ctx: PipelineContext, options: AnalyzeOptions = {}): Promise<StageResult> {
  const db = getDb();
  const settings = getSettings();
  const errors: string[] = [];
  let itemsProcessed = 0;
  let budgetExhausted = false;
  let budgetSkippedCount = 0;

  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(FINAL_DIR, { recursive: true });
  mkdirSync(IMPACT_CHECKS_DIR, { recursive: true });
  cleanupStaleTmpFiles();
  cleanupStaleImpactCheckFiles(settings.impactCheck?.maxAgeDays ?? 30);

  let pendingPRs: PRRow[];
  if (options.dateRange) {
    const { startUnix, endUnix } = options.dateRange;
    pendingPRs = db
      .query<PRRow, [number, number]>(
        `SELECT pr.*, p.description, p.language, p.topics, p.overview
         FROM pull_requests pr JOIN projects p ON pr.project_id = p.id
         WHERE (pr.analysis_status = 'pending'
            OR (pr.analysis_status = 'failed' AND pr.retry_count < 3))
           AND pr.merged_at >= ?
           AND pr.merged_at <= ?`
      )
      .all(startUnix, endUnix);
  } else {
    pendingPRs = db
      .query<PRRow, []>(
        `SELECT pr.*, p.description, p.language, p.topics, p.overview
         FROM pull_requests pr JOIN projects p ON pr.project_id = p.id
         WHERE pr.analysis_status = 'pending'
            OR (pr.analysis_status = 'failed' AND pr.retry_count < 3)`
      )
      .all();
  }

  console.log(`[Analyze] Found ${pendingPRs.length} PRs to analyze`);

  let larkBudgetAlertSent = false;

  for (let i = 0; i < pendingPRs.length; i++) {
    const pr = pendingPRs[i]!;

    const existingAnalysis = db
      .query<{ id: number }, [number]>(
        "SELECT id FROM analyses WHERE pr_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(pr.id);
    if (existingAnalysis) {
      db.run(`UPDATE pull_requests SET analysis_status = 'complete' WHERE id = ?`, [pr.id]);
      itemsProcessed++;
      console.log(
        `[Analyze] PR ${pr.id} (${pr.title}): already analyzed as #${existingAnalysis.id}, marked complete`
      );
      continue;
    }

    // Budget check before each PR
    const budget = getBudgetStatus();

    if (budget.action === "pause") {
      const remaining = pendingPRs.length - i;
      console.warn(
        `[Analyze] Budget at 100% ($${budget.estimatedCostUSD.toFixed(2)}/$${budget.budgetCapUSD}). Pausing analysis — ${remaining} PR(s) skipped.`
      );
      budgetExhausted = true;
      budgetSkippedCount = remaining;

      if (!larkBudgetAlertSent && settings.lark.webhookUrl) {
        const alertCard = buildBudgetAlertCard(budget.estimatedCostUSD, budget.budgetCapUSD);
        sendCard(settings.lark.webhookUrl, alertCard).catch((err) => {
          console.warn(`[Analyze] Budget alert send failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        larkBudgetAlertSent = true;
      }
      break;
    }

    if (budget.action === "skip_routine") {
      const preFilter = preFilterSignificance(pr);
      const isLargePR = (pr.files_changed ?? 0) > 10 || (pr.additions ?? 0) > 500;
      if (preFilter === "likely_routine" && !isLargePR) {
        db.run(`UPDATE pull_requests SET analysis_status = 'budget_skipped' WHERE id = ?`, [pr.id]);
        budgetSkippedCount++;
        console.log(
          `[Analyze] PR ${pr.id} (${pr.title}): budget_skipped (routine at ${(budget.usagePercent * 100).toFixed(0)}% usage)`
        );
        continue;
      }
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

      // Step 3: Atomic DB transaction — insert analyses + analysis_inputs (truncated_diff_path NULL until rename succeeds)
      let analysisId: number;
      let finalPath: string;
      try {
        const categoriesJson = JSON.stringify(reviewResult.output.categories);

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

          // Insert with truncated_diff_path = NULL; set after rename succeeds
          db.run(
            `INSERT INTO analysis_inputs
               (analysis_id, prompt_version, input_quality, rendered_project_context,
                file_manifest, diff_included_files, diff_total_files, diff_truncated,
                truncated_diff_path)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
            [
              aid,
              reviewResult.promptVersion,
              reviewResult.inputQuality,
              reviewResult.renderedProjectContext,
              reviewResult.fileManifest,
              reviewResult.diffIncludedFiles,
              reviewResult.diffTotalFiles,
              reviewResult.diffTruncated ? 1 : 0,
            ]
          );

          db.run(`UPDATE pull_requests SET analysis_status = 'complete' WHERE id = ?`, [pr.id]);

          return { aid, diffPath: `${FINAL_DIR}/${aid}.diff` };
        })();

        analysisId = insertResult.aid;
        finalPath = insertResult.diffPath;

        // Step 4: rename tmp → final, then update path in DB
        try {
          renameSync(tmpPath, finalPath);
          db.run(
            `UPDATE analysis_inputs SET truncated_diff_path = ? WHERE analysis_id = ?`,
            [finalPath, analysisId]
          );
        } catch (renameErr) {
          // rename failed — truncated_diff_path stays NULL, audit export marks this as snapshot_missing
          console.error(`[Analyze] PR ${pr.id}: rename failed: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`);
        }

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
