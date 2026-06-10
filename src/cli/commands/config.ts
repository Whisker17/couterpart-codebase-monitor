import { readFileSync } from "node:fs";
import { getSettings } from "../../config/settings";
import { getTrackedProjects } from "../../config/projects";
import type { GlobalFlags } from "../args";
import { printJson, printRows } from "../output";

function envSet(name: string): boolean {
  return Boolean(process.env[name]);
}

export async function configShowCommand(args: string[], global: GlobalFlags): Promise<number> {
  const section = args[0] ?? "all";
  const settings = getSettings();
  const rawConfig = JSON.parse(readFileSync("config/settings.json", "utf-8")) as {
    llm: { baseUrlEnvVar: string; apiKeyEnvVar: string };
    github: { tokenEnvVar: string };
    lark: { webhookUrlEnvVar: string };
  };
  const projects = getTrackedProjects();
  const budgetView = {
    ...settings.budget,
    diffTokenBudget: settings.llm.diffTokenBudget,
    maxManifestEntries: settings.llm.maxManifestEntries,
  };
  const payload = {
    settings: {
      llm: {
        model: settings.llm.model,
        maxTokensPerCall: settings.llm.maxTokensPerCall,
        diffTokenBudget: settings.llm.diffTokenBudget,
        maxManifestEntries: settings.llm.maxManifestEntries,
        baseUrlSet: envSet(rawConfig.llm.baseUrlEnvVar),
        apiKeySet: envSet(rawConfig.llm.apiKeyEnvVar),
      },
      github: { tokenSet: envSet(rawConfig.github.tokenEnvVar) },
      lark: { webhookUrlSet: envSet(rawConfig.lark.webhookUrlEnvVar) },
      schedule: settings.schedule,
      budget: budgetView,
    },
    projects: projects.map((p) => ({
      id: `${p.org}/${p.repo}`,
      org: p.org,
      repo: p.repo,
      url: p.url,
      tags: p.tags ?? [],
      notes: p.notes ?? null,
    })),
  };

  if (global.json) {
    printJson(section === "projects" ? payload.projects : section === "budget" ? payload.settings.budget : payload);
    return 0;
  }

  if (section === "projects") {
    printRows(payload.projects as unknown as Array<Record<string, unknown>>);
  } else if (section === "budget") {
    printRows([payload.settings.budget] as Array<Record<string, unknown>>);
  } else if (section === "all") {
    console.log("Settings:");
    printRows([payload.settings.llm, payload.settings.schedule, payload.settings.budget] as Array<Record<string, unknown>>);
    console.log(`Projects: ${payload.projects.length}`);
    printRows(payload.projects as unknown as Array<Record<string, unknown>>);
  } else {
    throw new Error(`Invalid config section "${section}". Expected projects, budget, or omitted.`);
  }
  return 0;
}
