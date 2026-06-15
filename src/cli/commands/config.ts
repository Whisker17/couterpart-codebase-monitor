import { readFileSync } from "node:fs";
import { getSettings } from "../../config/settings";
import { getTrackedProjects } from "../../config/projects";
import type { GlobalFlags } from "../args";
import { printJson, printRows } from "../output";

function envSet(name: string): boolean {
  return Boolean(process.env[name]);
}

type SettingsForConfigShow = ReturnType<typeof getSettings>;
type ProjectsForConfigShow = ReturnType<typeof getTrackedProjects>;

interface RawSettingsEnvConfig {
  llm: { baseUrlEnvVar: string; apiKeyEnvVar: string };
  github: { tokenEnvVar: string };
  lark: { webhookUrlEnvVar: string };
}

const CONFIG_SHOW_SECTIONS = ["all", "projects", "budget", "impact-check"] as const;

type ConfigShowSection = (typeof CONFIG_SHOW_SECTIONS)[number];

function toConfigShowSection(section: string): ConfigShowSection {
  if ((CONFIG_SHOW_SECTIONS as readonly string[]).includes(section)) {
    return section as ConfigShowSection;
  }
  throw new Error(`Invalid config section "${section}". Expected projects, budget, impact-check, or omitted.`);
}

export function buildConfigShowPayload(
  settings: SettingsForConfigShow,
  projects: ProjectsForConfigShow,
  rawConfig: RawSettingsEnvConfig
) {
  const budgetView = {
    ...settings.budget,
    diffTokenBudget: settings.llm.diffTokenBudget,
    maxManifestEntries: settings.llm.maxManifestEntries,
  };

  return {
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
      impactCheck: settings.impactCheck,
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
}

export async function configShowCommand(args: string[], global: GlobalFlags): Promise<number> {
  const section = toConfigShowSection(args[0] ?? "all");
  const settings = getSettings();
  const rawConfig = JSON.parse(readFileSync("config/settings.json", "utf-8")) as RawSettingsEnvConfig;
  const projects = getTrackedProjects();
  const payload = buildConfigShowPayload(settings, projects, rawConfig);

  if (global.json) {
    printJson(
      section === "projects"
        ? payload.projects
        : section === "budget"
          ? payload.settings.budget
          : section === "impact-check"
            ? payload.settings.impactCheck
            : payload
    );
    return 0;
  }

  if (section === "projects") {
    printRows(payload.projects as unknown as Array<Record<string, unknown>>);
  } else if (section === "budget") {
    printRows([payload.settings.budget] as Array<Record<string, unknown>>);
  } else if (section === "impact-check") {
    printRows([payload.settings.impactCheck ?? {}] as Array<Record<string, unknown>>);
  } else if (section === "all") {
    console.log("Settings:");
    printRows(
      [payload.settings.llm, payload.settings.schedule, payload.settings.budget, payload.settings.impactCheck ?? {}] as Array<
        Record<string, unknown>
      >
    );
    console.log(`Projects: ${payload.projects.length}`);
    printRows(payload.projects as unknown as Array<Record<string, unknown>>);
  }
  return 0;
}
