import {
  buildDailyCard,
  type GroupedAnalyses,
  type LarkCard,
} from "../report-generator/templates/daily-card";

const LEVEL1_BYTES = 20_000;
const LEVEL2_BYTES = 28_000;

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

function filterRoutinePRs(analyses: GroupedAnalyses): {
  filtered: GroupedAnalyses;
  omittedCount: number;
} {
  let omittedCount = 0;
  const filtered = analyses
    .map((p) => {
      const significant = p.prs.filter((pr) => pr.significance !== "routine");
      omittedCount += p.prs.length - significant.length;
      return { ...p, prs: significant, prCount: significant.length };
    })
    .filter((p) => p.prs.length > 0);
  return { filtered, omittedCount };
}

export interface FormatResult {
  cards: LarkCard[];
  errors: string[];
}

export function formatReport(
  date: string,
  analyses: GroupedAnalyses,
  partialWarning: string | undefined
): FormatResult {
  const errors: string[] = [];

  // Level 1: full card
  const fullCard = buildDailyCard(date, analyses, partialWarning);
  if (byteLength(JSON.stringify(fullCard)) <= LEVEL1_BYTES) {
    return { cards: [fullCard], errors };
  }

  // Level 2: notable/directional_shift only, append omit note
  const { filtered, omittedCount } = filterRoutinePRs(analyses);
  const trimmedCard = buildDailyCard(date, filtered, partialWarning);
  const summaryEl = trimmedCard.elements.find(
    (el): el is { tag: "markdown"; content: string } => (el as { tag: string }).tag === "markdown"
  );
  if (summaryEl) {
    summaryEl.content += `\n_${omittedCount} routine PR${omittedCount !== 1 ? "s" : ""} omitted_`;
  }
  const trimmedSize = byteLength(JSON.stringify(trimmedCard));
  if (trimmedSize <= LEVEL2_BYTES) {
    console.warn(
      `[Formatter] Card trimmed to notable/directional PRs (${omittedCount} routine omitted)`
    );
    return { cards: [trimmedCard], errors };
  }

  // Level 3: one card per project
  console.warn(
    `[Formatter] Trimmed card still ${trimmedSize} bytes — splitting per project`
  );
  const perProjectCards = analyses.map((p) => buildDailyCard(date, [p], partialWarning));
  for (const card of perProjectCards) {
    const size = byteLength(JSON.stringify(card));
    if (size > 30_000) {
      errors.push(
        `Project card still oversized (${size} bytes) after split — sent anyway`
      );
    }
  }
  return { cards: perProjectCards, errors };
}
