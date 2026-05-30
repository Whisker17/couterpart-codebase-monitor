/**
 * E2E integration runner — manually triggers the full pipeline once.
 * Usage: bun run src/e2e-run.ts
 */
import { validateEnv } from "./config/settings.ts";
import { getDb, closeDb } from "./storage/db";
import { runPipeline } from "./pipeline/runner";
import { stage as collect } from "./pipeline/stages/collect";
import { stage as analyze } from "./pipeline/stages/analyze";
import { stage as report } from "./pipeline/stages/report";

async function main() {
  validateEnv();
  getDb();

  const start = Date.now();
  console.log("[E2E] Starting full pipeline run...");

  const results = await runPipeline([collect, analyze, report]);

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

  closeDb();
  process.exit(0);
}

main().catch((err) => {
  console.error("[E2E] Fatal error:", err);
  process.exit(1);
});
