import { readFileSync } from "fs";
import { join } from "path";

interface SettingsConfig {
  llm: {
    model: string;
    baseUrlEnvVar: string;
    apiKeyEnvVar: string;
    maxTokensPerCall: number;
    diffTokenBudget: number;
    maxManifestEntries: number;
  };
  lark: {
    webhookUrlEnvVar: string;
  };
  github: {
    tokenEnvVar: string;
  };
  schedule: {
    dailyCron: string;
    weeklyCron: string;
  };
  budget: {
    monthlyCap: number;
    warningThreshold: number;
    cutoffThreshold: number;
  };
}

export interface Settings {
  llm: {
    model: string;
    baseUrl: string;
    apiKey: string;
    maxTokensPerCall: number;
    diffTokenBudget: number;
    maxManifestEntries: number;
  };
  lark: {
    webhookUrl: string | undefined;
  };
  github: {
    token: string;
  };
  schedule: {
    dailyCron: string;
    weeklyCron: string;
  };
  budget: {
    monthlyCap: number;
    warningThreshold: number;
    cutoffThreshold: number;
  };
}

let _settings: Settings | null = null;

export function getSettings(): Settings {
  if (_settings) return _settings;

  const configPath = join(process.cwd(), "config", "settings.json");
  const raw = readFileSync(configPath, "utf-8");
  const cfg = JSON.parse(raw) as SettingsConfig;

  _settings = {
    llm: {
      model: cfg.llm.model,
      baseUrl: process.env[cfg.llm.baseUrlEnvVar] ?? "",
      apiKey: process.env[cfg.llm.apiKeyEnvVar] ?? "",
      maxTokensPerCall: cfg.llm.maxTokensPerCall,
      diffTokenBudget: cfg.llm.diffTokenBudget,
      maxManifestEntries: cfg.llm.maxManifestEntries,
    },
    lark: {
      webhookUrl: process.env[cfg.lark.webhookUrlEnvVar],
    },
    github: {
      token: process.env[cfg.github.tokenEnvVar] ?? "",
    },
    schedule: cfg.schedule,
    budget: cfg.budget,
  };

  return _settings;
}

export function _resetSettingsCache(): void {
  _settings = null;
}

const REQUIRED_ENV_VARS = ["GITHUB_TOKEN", "LLM_BASE_URL", "LLM_API_KEY"];

export function validateEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(
      `Missing required environment variables:\n  ${missing.join("\n  ")}\n\nCheck .env.example for reference.`
    );
    process.exit(1);
  }
}
