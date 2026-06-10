import { getDb } from "../../storage/db";
import { getSettings } from "../../config/settings";
import { getMonthPeriod } from "../../utils/time-window";
import { flagString, type GlobalFlags, type FlagValue } from "../args";
import { printJson, printRows } from "../output";

function localMonth(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date());
  const year = Number(parts.find((p) => p.type === "year")!.value);
  const month = Number(parts.find((p) => p.type === "month")!.value);
  return `${year}-${String(month).padStart(2, "0")}`;
}

export async function budgetCommand(
  flags: Record<string, FlagValue>,
  global: GlobalFlags
): Promise<number> {
  const settings = getSettings();
  const timezone = global.timezone ?? settings.schedule.timezone;
  const month = flagString(flags, "month") ?? localMonth(timezone);
  const period = getMonthPeriod(timezone, month);
  const row = getDb()
    .query<
      { analyses: number; prs: number; input_tokens: number | null; output_tokens: number | null; total_cost: number | null },
      [number, number]
    >(
      `SELECT COUNT(a.id) as analyses,
              COUNT(DISTINCT a.pr_id) as prs,
              SUM(a.input_tokens) as input_tokens,
              SUM(a.output_tokens) as output_tokens,
              SUM(a.estimated_cost_usd) as total_cost
       FROM analyses a
       WHERE a.analyzed_at >= ? AND a.analyzed_at <= ?`
    )
    .get(period.startUnix, period.endUnix)!;

  const cost = row.total_cost ?? 0;
  const percent = settings.budget.monthlyCap > 0 ? cost / settings.budget.monthlyCap : 0;
  const action =
    percent >= settings.budget.cutoffThreshold
      ? "pause"
      : percent >= settings.budget.warningThreshold
        ? "skip_routine"
        : "normal";
  const payload = {
    month,
    period,
    analyses: row.analyses,
    prs: row.prs,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    estimatedCostUsd: cost,
    averageCostPerAnalysisUsd: row.analyses > 0 ? cost / row.analyses : 0,
    budgetCapUsd: settings.budget.monthlyCap,
    remainingUsd: Math.max(0, settings.budget.monthlyCap - cost),
    usagePercent: percent,
    action,
  };

  if (global.json) printJson(payload);
  else printRows([payload] as unknown as Array<Record<string, unknown>>);
  return 0;
}
