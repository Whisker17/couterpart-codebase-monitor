import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { getDb } from "../../storage/db";
import { getSettings } from "../../config/settings";
import { reviewPR } from "./llm-reviewer";
import { buildAnalysisContext } from "../../pipeline/stages/analyze";

const analyzePRTool: AgentTool = {
  name: "analyze-pr",
  label: "Analyze PR",
  description: "Runs diff-aware LLM analysis on a single pull request by its DB id.",
  parameters: Type.Object({
    pr_id: Type.Number({ description: "Pull request DB row id" }),
  }),
  execute: async (_toolCallId, params) => {
    const db = getDb();

    const row = db
      .query<
        {
          id: number;
          title: string;
          author: string | null;
          body: string | null;
          files_changed: number | null;
          additions: number | null;
          deletions: number | null;
          diff_path: string | null;
          diff_status: string;
          project_id: string;
          description: string | null;
          language: string | null;
          topics: string | null;
          overview: string | null;
        },
        [number]
      >(
        `SELECT pr.*, p.description, p.language, p.topics, p.overview
         FROM pull_requests pr JOIN projects p ON pr.project_id = p.id
         WHERE pr.id = ?`
      )
      .get((params as { pr_id: number }).pr_id);

    if (!row) {
      return {
        content: [{ type: "text" as const, text: `PR id ${(params as { pr_id: number }).pr_id} not found` }],
        details: { error: "not_found" },
      };
    }

    // Budget check before calling LLM
    const settings = getSettings();
    const now = new Date();
    const monthStartUnix = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
    const budgetRow = db
      .query<{ total_cost: number | null }, [number]>(
        `SELECT SUM(estimated_cost_usd) as total_cost FROM analyses WHERE analyzed_at >= ?`
      )
      .get(monthStartUnix);
    const monthlySpend = budgetRow?.total_cost ?? 0;
    if (monthlySpend >= settings.budget.monthlyCap) {
      return {
        content: [{ type: "text" as const, text: `Monthly budget cap ($${settings.budget.monthlyCap}) reached. Analysis skipped.` }],
        details: { error: "budget_exhausted" },
      };
    }

    const ctx = await buildAnalysisContext(row);
    const result = await reviewPR(ctx, row);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              significance: result.output.significance,
              summary: result.output.summary,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              estimatedCostUsd: result.estimatedCostUsd,
            },
            null,
            2
          ),
        },
      ],
      details: result,
    };
  },
};

export function register(agent: Agent): void {
  agent.state.tools = (agent.state.tools ?? []).filter((t) => t.name !== analyzePRTool.name);
  agent.state.tools.push(analyzePRTool);
}
