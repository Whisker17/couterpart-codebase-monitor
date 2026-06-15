// Best-effort Simplified-Chinese translation of short free-text fields for the impact alert card,
// reusing the project's Anthropic-compatible LLM gateway (same baseURL/apiKey as the analyzer/checker).
// Strings that are already mostly Chinese are passed through untouched (no wasted call). On any
// failure the originals are returned — translation must never block or break an alert.
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";

export interface TranslateSettings {
  llm: { model: string; baseUrl: string; apiKey: string };
}

export interface TranslateDeps {
  generateObjectFn?: typeof generateObject;
}

function resolveBaseUrl(rawUrl: string): string | undefined {
  if (!rawUrl) return undefined;
  const trimmed = rawUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function isMostlyChinese(s: string): boolean {
  const cjk = (s.match(/[一-鿿]/g) ?? []).length;
  const latinWords = (s.match(/[A-Za-z]{3,}/g) ?? []).length;
  return cjk > 0 && cjk >= latinWords;
}

const TranslationSchema = z.object({
  translations: z.array(z.string()),
});

/**
 * Translate `texts` to Simplified Chinese, preserving code identifiers / paths / refs verbatim.
 * Returns an array aligned 1:1 with the input (untranslated entries are returned as-is).
 */
export async function translateToZh(
  texts: string[],
  settings: TranslateSettings,
  deps: TranslateDeps = {}
): Promise<string[]> {
  const out = [...texts];
  const pending = texts.map((t, i) => ({ t, i })).filter(({ t }) => t.trim().length > 0 && !isMostlyChinese(t));
  if (pending.length === 0) return out;
  if (!settings.llm.apiKey) return out;

  try {
    const generate = deps.generateObjectFn ?? generateObject;
    const anthropic = createAnthropic({
      baseURL: resolveBaseUrl(settings.llm.baseUrl),
      apiKey: settings.llm.apiKey,
    });
    const numbered = pending.map((x, k) => `${k}. ${x.t}`).join("\n");
    const result = await generate({
      model: anthropic(settings.llm.model),
      schema: TranslationSchema,
      maxRetries: 1,
      system:
        "You translate short engineering notes into concise, natural Simplified Chinese for blockchain " +
        "(Go/Rust) engineers. Rules: (1) return `translations` as an array with EXACTLY one entry per " +
        "input line, in the SAME order; (2) PRESERVE verbatim — do NOT translate — code identifiers, " +
        "struct/field names, file paths, package names, PR refs (e.g. `#33589`), versions, and anything " +
        "in backticks; (3) keep it terse and engineer-readable; (4) no extra commentary.",
      prompt: `Translate each line to Simplified Chinese:\n${numbered}`,
    });
    const translations = result.object.translations;
    pending.forEach((x, k) => {
      const tr = translations[k];
      if (typeof tr === "string" && tr.trim()) out[x.i] = tr.trim();
    });
    return out;
  } catch {
    return out; // best-effort: never block an alert on translation failure
  }
}
