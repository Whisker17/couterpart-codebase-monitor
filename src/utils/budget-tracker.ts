import { getDb } from "../storage/db";
import { getSettings } from "../config/settings";

export interface BudgetStatus {
  tokensUsedThisMonth: number;
  estimatedCostUSD: number;
  budgetCapUSD: number;
  usagePercent: number;
  action: "normal" | "skip_routine" | "pause";
}

export interface ImpactCheckBudgetStatus {
  estimatedCostUSD: number;
  budgetCapUSD: number;
  usagePercent: number;
  action: "normal" | "pause";
}

function getMonthStartUnix(): number {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
}

export function getBudgetStatus(): BudgetStatus {
  const db = getDb();
  const settings = getSettings();
  const monthStart = getMonthStartUnix();

  const analysesRow = db
    .query<
      { total_input: number | null; total_output: number | null; total_cost: number | null },
      [number]
    >(
      `SELECT SUM(input_tokens) as total_input, SUM(output_tokens) as total_output,
              SUM(estimated_cost_usd) as total_cost
       FROM analyses WHERE analyzed_at >= ?`
    )
    .get(monthStart);

  const impactRow = db
    .query<{ total_cost: number | null }, [number]>(
      `SELECT SUM(estimated_cost_usd) as total_cost
       FROM impact_checks WHERE checked_at >= ?`
    )
    .get(monthStart);

  const tokensUsedThisMonth = (analysesRow?.total_input ?? 0) + (analysesRow?.total_output ?? 0);
  const estimatedCostUSD = (analysesRow?.total_cost ?? 0) + (impactRow?.total_cost ?? 0);
  const budgetCapUSD = settings.budget.monthlyCap;
  const usagePercent = budgetCapUSD > 0 ? estimatedCostUSD / budgetCapUSD : 0;

  let action: "normal" | "skip_routine" | "pause";
  if (usagePercent >= settings.budget.cutoffThreshold) {
    action = "pause";
  } else if (usagePercent >= settings.budget.warningThreshold) {
    action = "skip_routine";
  } else {
    action = "normal";
  }

  return { tokensUsedThisMonth, estimatedCostUSD, budgetCapUSD, usagePercent, action };
}

export function getImpactCheckBudgetStatus(): ImpactCheckBudgetStatus {
  const db = getDb();
  const settings = getSettings();
  const monthStart = getMonthStartUnix();

  const row = db
    .query<{ total_cost: number | null }, [number]>(
      `SELECT SUM(estimated_cost_usd) as total_cost
       FROM impact_checks WHERE checked_at >= ?`
    )
    .get(monthStart);

  const estimatedCostUSD = row?.total_cost ?? 0;
  const budgetCapUSD = settings.impactCheck?.monthlySubCap ?? 50;
  const usagePercent = budgetCapUSD > 0 ? estimatedCostUSD / budgetCapUSD : 0;
  const action: "normal" | "pause" = usagePercent >= 1.0 ? "pause" : "normal";

  return { estimatedCostUSD, budgetCapUSD, usagePercent, action };
}
