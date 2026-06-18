import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { validateEnv } from "./config/settings.ts";
import { getDb } from "./storage/db";
import { register as registerHello } from "./extensions/hello/index.ts";
import { registerScheduler } from "./scheduler/cron";
import { startReadinessHeartbeat } from "./pipeline/runner";
import { exportAnalyses } from "./utils/audit-export";
import { runStartupBackfillIfNeeded } from "./startup/backfill";
import { runAppStartup } from "./startup/app";
import type { StartupAgent } from "./startup/app";

function buildModel() {
  const baseModel = getModel("anthropic", "claude-sonnet-4-20250514");
  const baseUrl = process.env.LLM_BASE_URL;
  return baseUrl ? { ...baseModel, baseUrl } : baseModel;
}

async function runExportAudit(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--export-audit" && a !== "export-audit");

  function getArg(flag: string): string | undefined {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  }

  const sinceArg = getArg("--since");
  const untilArg = getArg("--until");
  const outputArg = getArg("--output");

  if (!sinceArg || !untilArg || !outputArg) {
    console.error("Usage: bun run src/index.ts --export-audit --since <date> --until <date> --output <path>");
    process.exit(1);
  }

  const since = new Date(sinceArg);
  const until = new Date(untilArg);

  if (isNaN(since.getTime()) || isNaN(until.getTime())) {
    console.error("Invalid date format. Use ISO 8601 (e.g. 2026-06-10).");
    process.exit(1);
  }

  getDb();
  const count = await exportAnalyses(since, until, outputArg);
  console.log(`Exported ${count} record(s) to ${outputArg}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--export-audit") || argv[0] === "export-audit") {
    return runExportAudit();
  }

  await runAppStartup({
    validateEnv,
    getDb,
    runStartupBackfillIfNeeded,
    buildModel,
    createAgent: (model) =>
      new Agent({
        initialState: { model, systemPrompt: "Counterpart Monitor agent." },
        getApiKey: () =>
          process.env.LLM_BASE_URL && process.env.LLM_API_KEY ? process.env.LLM_API_KEY : undefined,
      }) as StartupAgent,
    registerHello: (agent) => registerHello(agent as unknown as Agent),
    startReadinessHeartbeat,
    registerScheduler,
    log: console.log,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
