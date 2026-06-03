import { mkdir } from "node:fs/promises";
import { sendCard } from "../extensions/lark-dispatcher/webhook";

export interface StageResult {
  success: boolean;
  itemsProcessed: number;
  errors: string[];
  durationMs: number;
  failedProjects?: string[];
  budgetExhausted?: boolean;
  budgetSkippedCount?: number;
}

export type ReportMode = "daily" | "weekly" | "monthly";

export interface PipelineContext {
  stageResults: Map<string, StageResult>;
  reportMode: ReportMode;
  timezone?: string;
}

export interface PipelineStage {
  name: string;
  execute: (ctx: PipelineContext) => Promise<StageResult>;
}

export interface HealthRecord {
  lastRun: string;
  success: boolean;
  prsProcessed: number;
  errors: string[];
  consecutiveFailures: number;
}

const DEFAULT_HEALTH_PATH = "data/health.json";
const CONSECUTIVE_FAILURE_THRESHOLD = 3;

async function readExistingHealth(healthPath: string): Promise<HealthRecord | null> {
  try {
    const text = await Bun.file(healthPath).text();
    return JSON.parse(text) as HealthRecord;
  } catch {
    return null;
  }
}

function buildHealthAlertCard(consecutiveFailures: number): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "Pipeline Health Alert" },
      template: "red",
    },
    elements: [
      {
        tag: "markdown",
        content: `**Counterpart Monitor pipeline has failed ${consecutiveFailures} consecutive times.**\n\nAll stages failed on each of the last ${consecutiveFailures} runs. Check logs:\n\`\`\`\npm2 logs counterpart-monitor\n\`\`\``,
      },
    ],
  };
}

export interface HealthCheckOptions {
  healthJsonPath?: string;
}

export async function writeHealthAndMaybeAlert(
  stageResults: Map<string, StageResult>,
  options: HealthCheckOptions = {}
): Promise<void> {
  const healthPath = options.healthJsonPath ?? DEFAULT_HEALTH_PATH;
  const prsProcessed = stageResults.get("collect")?.itemsProcessed ?? 0;
  const allErrors: string[] = [];
  let anySuccess = false;

  for (const result of stageResults.values()) {
    if (result.success) anySuccess = true;
    allErrors.push(...result.errors);
  }

  const allFailed = stageResults.size > 0 && !anySuccess;
  const prev = await readExistingHealth(healthPath);
  const consecutiveFailures = allFailed ? (prev?.consecutiveFailures ?? 0) + 1 : 0;

  const record: HealthRecord = {
    lastRun: new Date().toISOString(),
    success: anySuccess,
    prsProcessed,
    errors: allErrors,
    consecutiveFailures,
  };

  const dir = healthPath.includes("/") ? healthPath.split("/").slice(0, -1).join("/") : ".";
  await mkdir(dir, { recursive: true });
  await Bun.write(healthPath, JSON.stringify(record, null, 2) + "\n");

  if (consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
    const webhookUrl = process.env.LARK_WEBHOOK_URL;
    if (webhookUrl) {
      await sendCard(webhookUrl, buildHealthAlertCard(consecutiveFailures)).catch((err) => {
        console.error("[Pipeline] Failed to send health alert:", err);
      });
    } else {
      console.warn("[Pipeline] LARK_WEBHOOK_URL not set — health alert suppressed");
    }
  }
}

export async function runPipeline(
  stages: PipelineStage[],
  options?: { reportMode?: ReportMode; timezone?: string; healthCheckOptions?: HealthCheckOptions }
): Promise<Map<string, StageResult>> {
  const ctx: PipelineContext = {
    stageResults: new Map(),
    reportMode: options?.reportMode ?? "daily",
    timezone: options?.timezone ?? "UTC",
  };

  for (const stage of stages) {
    console.log(`[Pipeline] Starting stage: ${stage.name}`);
    const start = Date.now();

    let result: StageResult;
    try {
      result = await stage.execute(ctx);
      result = { ...result, durationMs: Date.now() - start };
    } catch (err) {
      const durationMs = Date.now() - start;
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[Pipeline] Stage ${stage.name} failed in ${durationMs}ms: ${error}`);
      result = { success: false, itemsProcessed: 0, errors: [error], durationMs };
    }

    ctx.stageResults.set(stage.name, result);
    console.log(
      `[Pipeline] Stage ${stage.name} completed in ${result.durationMs}ms (${result.itemsProcessed} items)`
    );
  }

  await writeHealthAndMaybeAlert(ctx.stageResults, options?.healthCheckOptions).catch((err) => {
    console.error("[Pipeline] Health check write failed:", err);
  });

  return ctx.stageResults;
}
