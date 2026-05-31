/**
 * E2E integration runner — manually triggers the full pipeline once.
 * Usage: bun run src/e2e-run.ts
 */
import { validateEnv } from "./config/settings.ts";
import { getDb, closeDb } from "./storage/db";
import { runPipeline, type PipelineStage, type StageResult } from "./pipeline/runner";
import { stage as collect } from "./pipeline/stages/collect";
import { stage as analyze } from "./pipeline/stages/analyze";
import { stage as report } from "./pipeline/stages/report";
import { stage as dispatch } from "./pipeline/stages/dispatch";

export function getE2EStages(): PipelineStage[] {
  return [collect, analyze, report, dispatch];
}

export function getExitCode(results: Map<string, StageResult>): 0 | 1 {
  return [...results.values()].some((result) => !result.success) ? 1 : 0;
}

export async function runE2E(): Promise<number> {
  validateEnv();
  getDb();

  const start = Date.now();
  console.log("[E2E] Starting full pipeline run...");

  const results = await runPipeline(getE2EStages());

  const totalMs = Date.now() - start;
  console.log(`\n[E2E] Pipeline complete in ${(totalMs / 1000).toFixed(1)}s`);

  for (const [name, result] of results) {
    const status = result.success ? "✓" : "✗";
    console.log(
      `  ${status} ${name}: ${result.itemsProcessed} items, ${result.errors.length} errors, ${result.durationMs}ms`
    );
    if (result.errors.length > 0) {
      for (const err of result.errors) {
        console.error(`    - ${err}`);
      }
    }
    if (result.budgetExhausted) {
      console.warn(`    ⚠ Budget exhausted — skipped ${result.budgetSkippedCount} PRs`);
    }
  }

  return getExitCode(results);
}

if (import.meta.main) {
  runE2E()
    .then((exitCode) => {
      closeDb();
      process.exit(exitCode);
    })
    .catch((err) => {
      console.error("[E2E] Fatal error:", err);
      closeDb();
      process.exit(1);
    });
}
