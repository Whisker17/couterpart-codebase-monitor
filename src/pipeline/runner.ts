import { mkdir } from "node:fs/promises";
import { sendCard } from "../extensions/lark-dispatcher/webhook";
import { reloadSafeConfig } from "../config/settings";
import type { SafeConfigSnapshot } from "../config/settings";
import { reloadTrackedProjects } from "../config/projects";
import type { TrackedProject } from "../config/projects";

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

export interface ReadinessRecord {
  updatedAt: string;
  status: "ready";
}

const DEFAULT_HEALTH_PATH = "data/health.json";
const DEFAULT_READINESS_PATH = "data/readiness.json";
const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const READINESS_HEARTBEAT_MS = 30_000;

function dirname(path: string): string {
  return path.includes("/") ? path.split("/").slice(0, -1).join("/") : ".";
}

export async function writeReadiness(readinessPath = DEFAULT_READINESS_PATH): Promise<void> {
  const dir = dirname(readinessPath);
  await mkdir(dir, { recursive: true });
  const record: ReadinessRecord = {
    updatedAt: new Date().toISOString(),
    status: "ready",
  };
  await Bun.write(readinessPath, JSON.stringify(record, null, 2) + "\n");
}

export async function startReadinessHeartbeat(
  readinessPath = DEFAULT_READINESS_PATH,
  intervalMs = READINESS_HEARTBEAT_MS
): Promise<ReturnType<typeof setInterval>> {
  await writeReadiness(readinessPath);
  return setInterval(() => {
    void writeReadiness(readinessPath).catch((err) => {
      console.error("[Readiness] Failed to write readiness heartbeat:", err);
    });
  }, intervalMs);
}

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

  const dir = dirname(healthPath);
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

function logConfigReloadDiff(
  prevSnapshot: SafeConfigSnapshot | null,
  nextSnapshot: SafeConfigSnapshot,
  prevProjects: TrackedProject[] | null,
  nextProjects: TrackedProject[]
): void {
  if (prevSnapshot !== null) {
    if (prevSnapshot.budget.monthlyCap !== nextSnapshot.budget.monthlyCap) {
      console.log(
        `[config-reload] budget.monthlyCap changed: $${prevSnapshot.budget.monthlyCap} -> $${nextSnapshot.budget.monthlyCap}`
      );
    }
    if (prevSnapshot.budget.warningThreshold !== nextSnapshot.budget.warningThreshold) {
      console.log(
        `[config-reload] budget.warningThreshold changed: ${prevSnapshot.budget.warningThreshold} -> ${nextSnapshot.budget.warningThreshold}`
      );
    }
    if (prevSnapshot.budget.cutoffThreshold !== nextSnapshot.budget.cutoffThreshold) {
      console.log(
        `[config-reload] budget.cutoffThreshold changed: ${prevSnapshot.budget.cutoffThreshold} -> ${nextSnapshot.budget.cutoffThreshold}`
      );
    }
    if (prevSnapshot.diffTokenBudget !== nextSnapshot.diffTokenBudget) {
      console.log(
        `[config-reload] llm.diffTokenBudget changed: ${prevSnapshot.diffTokenBudget} -> ${nextSnapshot.diffTokenBudget}`
      );
    }
    if (prevSnapshot.maxManifestEntries !== nextSnapshot.maxManifestEntries) {
      console.log(
        `[config-reload] llm.maxManifestEntries changed: ${prevSnapshot.maxManifestEntries} -> ${nextSnapshot.maxManifestEntries}`
      );
    }
  }

  if (prevProjects !== null) {
    const prevKeys = new Set(prevProjects.map((p) => `${p.org}/${p.repo}`));
    const nextKeys = new Set(nextProjects.map((p) => `${p.org}/${p.repo}`));
    const added = nextProjects.filter((p) => !prevKeys.has(`${p.org}/${p.repo}`));
    const removed = prevProjects.filter((p) => !nextKeys.has(`${p.org}/${p.repo}`));
    if (added.length > 0 || removed.length > 0) {
      const parts: string[] = [];
      if (added.length > 0)
        parts.push(`+${added.length} (new: ${added.map((p) => `${p.org}/${p.repo}`).join(", ")})`);
      if (removed.length > 0)
        parts.push(`-${removed.length} (removed: ${removed.map((p) => `${p.org}/${p.repo}`).join(", ")})`);
      console.log(`[config-reload] tracked projects changed: ${parts.join(", ")}`);
    }
  }
}

export async function runPipeline(
  stages: PipelineStage[],
  options?: { reportMode?: ReportMode; timezone?: string; healthCheckOptions?: HealthCheckOptions }
): Promise<Map<string, StageResult>> {
  const { snapshot, prevSnapshot } = reloadSafeConfig();
  const { projects, prevProjects } = reloadTrackedProjects();
  logConfigReloadDiff(prevSnapshot, snapshot, prevProjects, projects);

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
