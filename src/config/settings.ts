import { readFileSync } from "fs";
import { join } from "path";

export interface ImpactCheckConfig {
  enabled: boolean;
  maxChecksPerDay: number;
  maxStepsPerCheck: number;
  maxCostPerCheck: number;
  monthlySubCap: number;
  maxAgeDays: number;
  clonesDir: string;
  maxCloneDiskGB: number;
  codegraphEnabled: boolean;
}

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
    monthlyCron: string;
    timezone: string;
  };
  budget: {
    monthlyCap: number;
    warningThreshold: number;
    cutoffThreshold: number;
  };
  impactCheck?: ImpactCheckConfig;
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
    monthlyCron: string;
    timezone: string;
  };
  budget: {
    monthlyCap: number;
    warningThreshold: number;
    cutoffThreshold: number;
  };
  impactCheck?: ImpactCheckConfig;
}

export interface SafeConfigSnapshot {
  budget: {
    monthlyCap: number;
    warningThreshold: number;
    cutoffThreshold: number;
  };
  diffTokenBudget: number;
  maxManifestEntries: number;
  impactCheck?: ImpactCheckConfig;
}

let _settings: Settings | null = null;
let _settingsConfigPath: string | null = null;

export function _resetSettingsCache(): void {
  _settings = null;
}

export function _setSettingsConfigPath(path: string | null): void {
  _settingsConfigPath = path;
}

function getSettingsConfigPath(): string {
  return _settingsConfigPath ?? join(process.cwd(), "config", "settings.json");
}

function readAndParseSettingsConfig(): SettingsConfig {
  const raw = readFileSync(getSettingsConfigPath(), "utf-8");
  return JSON.parse(raw) as SettingsConfig;
}

function validateSafeFields(cfg: SettingsConfig): void {
  if (typeof cfg.budget.monthlyCap !== "number") throw new Error("budget.monthlyCap must be a number");
  if (typeof cfg.budget.warningThreshold !== "number") throw new Error("budget.warningThreshold must be a number");
  if (typeof cfg.budget.cutoffThreshold !== "number") throw new Error("budget.cutoffThreshold must be a number");
  if (typeof cfg.llm.diffTokenBudget !== "number") throw new Error("llm.diffTokenBudget must be a number");
  if (typeof cfg.llm.maxManifestEntries !== "number") throw new Error("llm.maxManifestEntries must be a number");
}

const DEFAULT_IMPACT_CHECK: ImpactCheckConfig = {
  enabled: false,
  maxChecksPerDay: 5,
  maxStepsPerCheck: 12,
  maxCostPerCheck: 1.0,
  monthlySubCap: 50,
  maxAgeDays: 7,
  clonesDir: "data/mantle-repos",
  maxCloneDiskGB: 10,
  codegraphEnabled: false,
};

function resolveImpactCheck(cfg: SettingsConfig): ImpactCheckConfig {
  if (!cfg.impactCheck) {
    console.info("[config] impactCheck section absent — impact checking disabled");
    return { ...DEFAULT_IMPACT_CHECK };
  }
  return cfg.impactCheck;
}

function buildSettingsFromConfig(cfg: SettingsConfig): Settings {
  return {
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
    impactCheck: resolveImpactCheck(cfg),
  };
}

function snapshotFromSettings(s: Settings): SafeConfigSnapshot {
  return {
    budget: { ...s.budget },
    diffTokenBudget: s.llm.diffTokenBudget,
    maxManifestEntries: s.llm.maxManifestEntries,
    impactCheck: s.impactCheck ? { ...s.impactCheck } : undefined,
  };
}

export function getSettings(): Settings {
  if (_settings) return _settings;
  const cfg = readAndParseSettingsConfig();
  validateSafeFields(cfg);
  _settings = buildSettingsFromConfig(cfg);
  return _settings;
}

export function reloadSafeConfig(): {
  snapshot: SafeConfigSnapshot;
  prevSnapshot: SafeConfigSnapshot | null;
  changed: boolean;
} {
  const prev = _settings ? snapshotFromSettings(_settings) : null;

  let cfg: SettingsConfig;
  try {
    cfg = readAndParseSettingsConfig();
    validateSafeFields(cfg);
  } catch (e) {
    if (prev) {
      console.warn(`[config-reload] Failed to reload settings.json, using cached config: ${e}`);
      return { snapshot: prev, prevSnapshot: prev, changed: false };
    }
    throw new Error(`[config-reload] settings.json invalid and no cached config is available: ${e}`);
  }

  if (!_settings) {
    _settings = buildSettingsFromConfig(cfg);
  } else {
    _settings.budget = cfg.budget;
    _settings.llm.diffTokenBudget = cfg.llm.diffTokenBudget;
    _settings.llm.maxManifestEntries = cfg.llm.maxManifestEntries;
    _settings.impactCheck = resolveImpactCheck(cfg);
  }

  const next = snapshotFromSettings(_settings);
  return { snapshot: next, prevSnapshot: prev, changed: JSON.stringify(prev) !== JSON.stringify(next) };
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
