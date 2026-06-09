/**
 * Daily report prompt lab.
 *
 * Usage:
 *   bun run scripts/daily-prompt-lab.ts
 *   bun run scripts/daily-prompt-lab.ts --prompt prompts/reports/daily/baseline.md --prompt prompts/reports/daily/significance-first.md
 *   bun run scripts/daily-prompt-lab.ts --date 2026-06-08 --out data/reports/prompt-lab
 *   bun run scripts/daily-prompt-lab.ts --dry-run
 *
 * Reads existing DB analyses for the previous local-day report window, runs one
 * or more daily presentation prompts against the exact same input, and writes
 * local comparison artifacts. It does not write reports/report_deliveries and
 * does not dispatch to Lark.
 */
import type { Database } from "bun:sqlite";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { mkdir, readdir, readFile, stat, writeFile } from "fs/promises";
import { basename, extname, join } from "path";
import { getDb, closeDb } from "../src/storage/db";
import { getSettings } from "../src/config/settings";
import {
  buildDailyPromptInput,
  renderDailyPrompt,
  type DailyPromptInput,
} from "../src/extensions/report-generator/daily-prompt-input";
import { buildDailyPromptCard } from "../src/extensions/report-generator/templates/daily-prompt-card";

const DEFAULT_PROMPT_DIR = "prompts/reports/daily";
const DEFAULT_OUTPUT_ROOT = "data/reports/prompt-lab";

export interface DailyPromptLabCliOptions {
  promptPaths: string[];
  outputRoot: string;
  date?: string;
  timezone?: string;
  dryRun: boolean;
  maxOutputTokens: number;
  runId?: string;
}

export interface DailyPromptLabOptions extends DailyPromptLabCliOptions {
  now?: Date;
}

export interface PromptVariantResult {
  name: string;
  promptPath: string;
  outputDir: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface DailyPromptLabResult {
  outputDir: string;
  input: DailyPromptInput;
  variants: PromptVariantResult[];
}

interface GeneratePromptOptions {
  prompt: string;
  maxOutputTokens: number;
}

interface GeneratedText {
  text: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export type GenerateDailyTextFn = (options: GeneratePromptOptions) => Promise<GeneratedText>;

export interface DailyPromptLabDeps {
  db?: Database;
  generateFn?: GenerateDailyTextFn;
}

function usage(): string {
  return `Usage:
  bun run scripts/daily-prompt-lab.ts [options]

Options:
  --prompt <path>             Prompt file or directory. Repeatable. Defaults to ${DEFAULT_PROMPT_DIR}
  --date <YYYY-MM-DD>         Anchor date; report window is the previous local day. Defaults to now
  --timezone <tz>             IANA timezone. Defaults to config/settings.json schedule.timezone
  --out <dir>                 Output root. Defaults to ${DEFAULT_OUTPUT_ROOT}
  --dry-run                   Render prompts and input only; do not call the LLM
  --max-output-tokens <n>     Max output tokens per prompt. Defaults to 4096
  --run-id <id>               Stable output directory suffix
  --help                      Show this help`;
}

export function parseArgs(argv: string[]): DailyPromptLabCliOptions {
  const opts: DailyPromptLabCliOptions = {
    promptPaths: [],
    outputRoot: DEFAULT_OUTPUT_ROOT,
    dryRun: false,
    maxOutputTokens: 4096,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--prompt":
        if (!argv[i + 1]) throw new Error("--prompt requires a path");
        opts.promptPaths.push(argv[++i]!);
        break;
      case "--date":
        if (!argv[i + 1]) throw new Error("--date requires YYYY-MM-DD");
        opts.date = argv[++i]!;
        break;
      case "--timezone":
        if (!argv[i + 1]) throw new Error("--timezone requires an IANA timezone");
        opts.timezone = argv[++i]!;
        break;
      case "--out":
        if (!argv[i + 1]) throw new Error("--out requires a directory");
        opts.outputRoot = argv[++i]!;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--max-output-tokens":
        if (!argv[i + 1]) throw new Error("--max-output-tokens requires a number");
        opts.maxOutputTokens = parsePositiveInteger(argv[++i]!, "--max-output-tokens");
        break;
      case "--run-id":
        if (!argv[i + 1]) throw new Error("--run-id requires a value");
        opts.runId = argv[++i]!;
        break;
      case "--help":
      case "-h":
        throw new HelpRequested();
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (opts.promptPaths.length === 0) {
    opts.promptPaths.push(DEFAULT_PROMPT_DIR);
  }

  return opts;
}

class HelpRequested extends Error {}

function parsePositiveInteger(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return n;
}

function nowFromDateString(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid --date "${date}". Expected YYYY-MM-DD.`);
  }
  return new Date(`${date}T12:00:00Z`);
}

export { buildDailyPromptInput, renderDailyPrompt as renderPrompt };

async function resolvePromptFiles(paths: string[]): Promise<string[]> {
  const files: string[] = [];

  for (const path of paths) {
    const st = await stat(path);
    if (st.isDirectory()) {
      const children = (await readdir(path))
        .filter((name) => name.endsWith(".md"))
        .sort()
        .map((name) => join(path, name));
      files.push(...children);
    } else {
      files.push(path);
    }
  }

  const unique = Array.from(new Set(files));
  if (unique.length === 0) {
    throw new Error(`No prompt markdown files found in: ${paths.join(", ")}`);
  }
  return unique;
}

function promptName(path: string): string {
  const raw = basename(path, extname(path)).toLowerCase();
  return raw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "prompt";
}

function timestampRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function resolveAnthropicBaseUrl(rawUrl: string): string | undefined {
  if (!rawUrl) return undefined;
  const trimmed = rawUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

async function defaultGenerateText({
  prompt,
  maxOutputTokens,
}: GeneratePromptOptions): Promise<GeneratedText> {
  const settings = getSettings();
  if (!settings.llm.apiKey || !settings.llm.baseUrl) {
    throw new Error("LLM credentials missing. Set LLM_BASE_URL and LLM_API_KEY, or use --dry-run.");
  }

  const anthropic = createAnthropic({
    baseURL: resolveAnthropicBaseUrl(settings.llm.baseUrl),
    apiKey: settings.llm.apiKey,
  });

  const result = await generateText({
    model: anthropic(settings.llm.model),
    prompt,
    maxOutputTokens,
    maxRetries: 2,
  });

  return {
    text: result.text,
    usage: {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    },
  };
}

function markdownPreview(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 700) return trimmed;
  return `${trimmed.slice(0, 700).trimEnd()}\n...`;
}

export async function runDailyPromptLab(
  options: DailyPromptLabOptions,
  deps: DailyPromptLabDeps = {}
): Promise<DailyPromptLabResult> {
  const db = deps.db ?? getDb();
  const settings = getSettings();
  const timezone = options.timezone ?? settings.schedule.timezone;
  const now = options.now ?? (options.date ? nowFromDateString(options.date) : new Date());
  const input = buildDailyPromptInput(db, timezone, now);

  const promptFiles = await resolvePromptFiles(options.promptPaths);
  const outputDir = join(
    options.outputRoot,
    `daily-${input.period.date}-${options.runId ?? timestampRunId()}`
  );
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "input.json"), JSON.stringify(input, null, 2));

  const generateFn = deps.generateFn ?? defaultGenerateText;
  const variants: PromptVariantResult[] = [];
  const indexParts: string[] = [
    "# Daily Prompt Lab",
    "",
    `Period: ${input.period.label}`,
    `Timezone: ${input.period.timezone}`,
    `Input: ${input.activitySummary.totalPrs} PRs across ${input.activitySummary.projectCount} projects`,
    "",
  ];

  for (const promptPath of promptFiles) {
    const name = promptName(promptPath);
    console.log(
      `[DailyPromptLab] ${options.dryRun ? "Rendering" : "Generating"} ${name} from ${promptPath}`
    );
    const variantDir = join(outputDir, name);
    await mkdir(variantDir, { recursive: true });

    const template = await readFile(promptPath, "utf-8");
    const prompt = renderDailyPrompt(template, input);
    await writeFile(join(variantDir, "prompt.md"), prompt);

    const generated = options.dryRun
      ? {
          text: `# ${name}\n\nDry run only. Review prompt.md, then rerun without --dry-run to call the LLM.\n`,
          usage: { inputTokens: 0, outputTokens: 0 },
        }
      : await generateFn({ prompt, maxOutputTokens: options.maxOutputTokens });

    await writeFile(join(variantDir, "output.md"), generated.text);
    const card = buildDailyPromptCard({
      date: input.period.date,
      markdown: generated.text,
      totalPrs: input.activitySummary.totalPrs,
      projectCount: input.activitySummary.projectCount,
      directionalShiftCount: input.activitySummary.directionalShiftCount,
      notableCount: input.activitySummary.notableCount,
      routineCount: input.activitySummary.routineCount,
      projects: input.projects,
    });
    await writeFile(join(variantDir, "card.json"), JSON.stringify(card, null, 2));
    await writeFile(
      join(variantDir, "meta.json"),
      JSON.stringify(
        {
          name,
          promptPath,
          dryRun: options.dryRun,
          usage: generated.usage ?? { inputTokens: 0, outputTokens: 0 },
          period: input.period,
          maxOutputTokens: options.maxOutputTokens,
        },
        null,
        2
      )
    );

    variants.push({
      name,
      promptPath,
      outputDir: variantDir,
      usage: {
        inputTokens: generated.usage?.inputTokens ?? 0,
        outputTokens: generated.usage?.outputTokens ?? 0,
      },
    });

    indexParts.push(`## ${name}`);
    indexParts.push("");
    indexParts.push(`Prompt: \`${promptPath}\``);
    indexParts.push("");
    indexParts.push(markdownPreview(generated.text));
    indexParts.push("");
  }

  await writeFile(join(outputDir, "index.md"), indexParts.join("\n"));

  return { outputDir, input, variants };
}

async function main(): Promise<number> {
  let options: DailyPromptLabCliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof HelpRequested) {
      console.log(usage());
      return 0;
    }
    console.error(`[DailyPromptLab] ${err instanceof Error ? err.message : String(err)}`);
    console.error(usage());
    return 1;
  }

  try {
    const result = await runDailyPromptLab(options);
    console.log(`[DailyPromptLab] Wrote ${result.variants.length} variant(s) to ${result.outputDir}`);
    for (const variant of result.variants) {
      console.log(
        `  - ${variant.name}: input=${variant.usage.inputTokens}, output=${variant.usage.outputTokens}`
      );
    }
    return 0;
  } catch (err) {
    console.error(`[DailyPromptLab] Failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    closeDb();
  }
}

if (import.meta.main) {
  const exitCode = await main();
  process.exit(exitCode);
}
