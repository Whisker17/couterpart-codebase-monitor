import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { getSettings } from "../../config/settings";
import type { GroupedAnalyses } from "./templates/daily-card";
import type { WeeklyReportData } from "./weekly";

const MAX_ITEMS_PER_CALL = 80;

const LocalizedDeliverySchema = z.object({
  entries: z.array(
    z.object({
      key: z.string(),
      text: z.string(),
    })
  ),
});

type GenerateObjectFn = typeof generateObject;
type LocalizedDeliveryOutput = z.infer<typeof LocalizedDeliverySchema>;
interface GenerateLocalizedOptions extends Record<string, unknown> {
  prompt: string;
}

type GenerateLocalizedFn = (options: GenerateLocalizedOptions) => Promise<{
  object: LocalizedDeliveryOutput;
}>;

interface LocalizeDeps {
  generateFn?: GenerateLocalizedFn;
  skipCredentialCheck?: boolean;
}

interface TextItem {
  key: string;
  text: string;
}

function resolveAnthropicBaseUrl(rawUrl: string): string | undefined {
  if (!rawUrl) return undefined;
  const trimmed = rawUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function hasChinese(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

function normalizeText(text: string | null | undefined): string | null {
  const normalized = text?.replace(/\s+/g, " ").trim();
  return normalized ? normalized : null;
}

function isTestRuntime(): boolean {
  return (
    process.env["NODE_ENV"] === "test" ||
    process.argv.some((arg) => arg === "test" || arg.includes("bun-test"))
  );
}

function collectDailyItems(analyses: GroupedAnalyses): TextItem[] {
  const items: TextItem[] = [];
  for (const project of analyses) {
    const topSignal = normalizeText(project.topDirectionSignal);
    if (topSignal && !hasChinese(topSignal)) {
      items.push({ key: `daily:top:${project.projectId}`, text: topSignal });
    }
    for (const pr of project.prs) {
      const summary = normalizeText(pr.summary);
      const direction = normalizeText(pr.directionSignal);
      if (summary && !hasChinese(summary)) {
        items.push({ key: `daily:pr:${project.projectId}:${pr.prNumber}:summary`, text: summary });
      }
      if (direction && !hasChinese(direction)) {
        items.push({ key: `daily:pr:${project.projectId}:${pr.prNumber}:direction`, text: direction });
      }
    }
  }
  return items;
}

function collectWeeklyItems(data: WeeklyReportData): TextItem[] {
  const items: TextItem[] = [];
  for (const direction of data.directionChanges) {
    direction.signals.forEach((signal, index) => {
      const text = normalizeText(signal);
      if (text && !hasChinese(text)) {
        items.push({ key: `weekly:direction:${direction.projectId}:${index}`, text });
      }
    });
  }
  for (const project of data.projectHighlights) {
    for (const highlight of project.highlights) {
      const summary = normalizeText(highlight.summary);
      const direction = normalizeText(highlight.directionSignal);
      if (summary && !hasChinese(summary)) {
        items.push({
          key: `weekly:highlight:${project.projectId}:${highlight.prNumber}:summary`,
          text: summary,
        });
      }
      if (direction && !hasChinese(direction)) {
        items.push({
          key: `weekly:highlight:${project.projectId}:${highlight.prNumber}:direction`,
          text: direction,
        });
      }
    }
  }
  return items;
}

function buildPrompt(items: TextItem[], start: number, total: number): string {
  return `把下面这些工程报告投递文案改写成简洁中文。
要求：
- 输出中文为主，保留必要专业术语、库名、协议名、产品名和缩写，例如 PR、API、SDK、gRPC、JSON-RPC、TEE、prover-service、Ethereum。
- 每条不超过 55 个中文字符或约 90 个英文字符。
- 降低实现细节密度，强调“发生了什么”和“意味着什么”。
- 不要改变 key，不要新增或删除条目。

本批次条目范围：${start + 1}-${start + items.length}/${total}

条目：
${items.map((item) => `- key: ${item.key}\n  text: ${item.text}`).join("\n")}`;
}

async function localizeItems(items: TextItem[], deps?: LocalizeDeps): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();
  if (!deps?.generateFn && isTestRuntime()) return new Map();

  const generateFn = (deps?.generateFn ?? generateObject) as GenerateLocalizedFn;
  const settings = deps?.generateFn ? null : getSettings();
  if (!deps?.skipCredentialCheck && settings && (!settings.llm.apiKey || !settings.llm.baseUrl)) return new Map();

  const anthropic = settings
    ? createAnthropic({
        baseURL: resolveAnthropicBaseUrl(settings.llm.baseUrl),
        apiKey: settings.llm.apiKey,
      })
    : null;

  const localized = new Map<string, string>();
  for (let i = 0; i < items.length; i += MAX_ITEMS_PER_CALL) {
    const batch = items.slice(i, i + MAX_ITEMS_PER_CALL);
    const result = await generateFn({
      ...(anthropic && settings ? { model: anthropic(settings.llm.model) } : {}),
      schema: LocalizedDeliverySchema,
      prompt: buildPrompt(batch, i, items.length),
      maxOutputTokens: Math.min(settings?.llm.maxTokensPerCall ?? 4096, 4096),
      maxRetries: 0,
    });

    for (const entry of result.object.entries) {
      const text = normalizeText(entry.text);
      if (text) localized.set(entry.key, text);
    }
  }
  return localized;
}

export async function localizeDailyDelivery(
  analyses: GroupedAnalyses,
  deps?: LocalizeDeps
): Promise<GroupedAnalyses> {
  const localized = analyses.map((project) => ({
    ...project,
    prs: project.prs.map((pr) => ({ ...pr })),
  }));

  try {
    const textByKey = await localizeItems(collectDailyItems(analyses), deps);
    for (const project of localized) {
      project.topDirectionSignal =
        textByKey.get(`daily:top:${project.projectId}`) ?? project.topDirectionSignal;
      for (const pr of project.prs) {
        pr.summary =
          textByKey.get(`daily:pr:${project.projectId}:${pr.prNumber}:summary`) ?? pr.summary;
        pr.directionSignal =
          textByKey.get(`daily:pr:${project.projectId}:${pr.prNumber}:direction`) ??
          pr.directionSignal;
      }
    }
  } catch (err) {
    console.warn(`[Report] Delivery localization skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  return localized;
}

export async function localizeWeeklyDelivery(
  data: WeeklyReportData,
  deps?: LocalizeDeps
): Promise<WeeklyReportData> {
  const localized: WeeklyReportData = {
    ...data,
    directionChanges: data.directionChanges.map((direction) => ({
      ...direction,
      signals: [...direction.signals],
    })),
    activitySummary: { ...data.activitySummary },
    projectHighlights: data.projectHighlights.map((project) => ({
      ...project,
      highlights: project.highlights.map((highlight) => ({ ...highlight })),
    })),
  };

  try {
    const textByKey = await localizeItems(collectWeeklyItems(data), deps);
    for (const direction of localized.directionChanges) {
      direction.signals = direction.signals.map(
        (signal, index) => textByKey.get(`weekly:direction:${direction.projectId}:${index}`) ?? signal
      );
    }
    for (const project of localized.projectHighlights) {
      for (const highlight of project.highlights) {
        highlight.summary =
          textByKey.get(`weekly:highlight:${project.projectId}:${highlight.prNumber}:summary`) ??
          highlight.summary;
        highlight.directionSignal =
          textByKey.get(`weekly:highlight:${project.projectId}:${highlight.prNumber}:direction`) ??
          highlight.directionSignal;
      }
    }
  } catch (err) {
    console.warn(`[Report] Weekly delivery localization skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  return localized;
}
