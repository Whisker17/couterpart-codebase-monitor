import { readFileSync } from "fs";
import { join } from "path";

export interface Settings {
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

let _settings: Settings | null = null;

export function getSettings(): Settings {
  if (_settings) return _settings;
  const configPath = join(process.cwd(), "config", "settings.json");
  const raw = readFileSync(configPath, "utf-8");
  _settings = JSON.parse(raw) as Settings;
  return _settings;
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
