import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { validateEnv } from "./config/settings.ts";
import { getDb } from "./storage/db";
import { register as registerHello } from "./extensions/hello/index.ts";
import { registerScheduler } from "./scheduler/cron";
import { startReadinessHeartbeat } from "./pipeline/runner";
import { exportAnalyses } from "./utils/audit-export";
import { runStartupBackfillIfNeeded } from "./startup/backfill";

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

  validateEnv();
  getDb();
  await runStartupBackfillIfNeeded();

  const model = buildModel();
  const agent = new Agent({
    initialState: { model, systemPrompt: "Counterpart Monitor agent." },
    getApiKey: () =>
      process.env.LLM_BASE_URL && process.env.LLM_API_KEY ? process.env.LLM_API_KEY : undefined,
  });

  // Load extensions. Each extension receives the agent and registers its tools.
  registerHello(agent);
  registerHello(agent); // second call must not duplicate tools (hot-reload idempotency check)
  if (agent.state.tools.filter((t) => t.name === "hello-world").length !== 1) {
    throw new Error("register() idempotency check failed: duplicate tool entries");
  }

  console.log("pi-agent initialized. Registered tools:", agent.state.tools.map((t) => t.name));

  // Validate hello-world tool by calling its execute function directly.
  const helloTool = agent.state.tools.find((t) => t.name === "hello-world");
  if (!helloTool) throw new Error("hello-world tool not registered");

  const result = await helloTool.execute("validate-0", {}, undefined, undefined);
  console.log("hello-world result:", result.details);

  console.log("Session ready. Hot-reload: modify a handler and re-register the extension to pick up changes.");

  await startReadinessHeartbeat();
  registerScheduler();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
