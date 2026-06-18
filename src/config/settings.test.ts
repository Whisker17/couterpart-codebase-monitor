import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getSettings,
  validateEnv,
  _resetSettingsCache,
  reloadSafeConfig,
  _setSettingsConfigPath,
} from "./settings.ts";

beforeEach(() => {
  _resetSettingsCache();
});

describe("getSettings", () => {
  beforeEach(() => {
    process.env["LLM_BASE_URL"] = "https://example.com/v1";
    process.env["LLM_API_KEY"] = "sk-test";
    process.env["GITHUB_TOKEN"] = "ghp_test";
    process.env["LARK_WEBHOOK_URL"] = "https://lark.example.com/hook";
  });

  afterEach(() => {
    delete process.env["LLM_BASE_URL"];
    delete process.env["LLM_API_KEY"];
    delete process.env["GITHUB_TOKEN"];
    delete process.env["LARK_WEBHOOK_URL"];
    _resetSettingsCache();
  });

  it("returns complete Settings object with expected defaults", () => {
    const s = getSettings();
    expect(s.llm.model).toBe("claude-opus-4-6");
    expect(s.llm.diffTokenBudget).toBe(8000);
    expect(s.llm.maxManifestEntries).toBe(100);
    expect(s.llm.maxTokensPerCall).toBe(8192);
    expect(s.budget.monthlyCap).toBe(80);
    expect(s.budget.warningThreshold).toBe(0.8);
    expect(s.startup.backfill.enabled).toBe(true);
    expect(s.startup.backfill.range).toBe("last7");
    expect(typeof s.schedule.dailyCron).toBe("string");
    expect(typeof s.schedule.weeklyCron).toBe("string");
    expect(typeof s.schedule.monthlyCron).toBe("string");
  });

  it("resolves llm.baseUrl from env var", () => {
    process.env["LLM_BASE_URL"] = "https://my-gateway.example.com/v1";
    _resetSettingsCache();
    const s = getSettings();
    expect(s.llm.baseUrl).toBe("https://my-gateway.example.com/v1");
  });

  it("resolves llm.apiKey from env var", () => {
    process.env["LLM_API_KEY"] = "sk-override-key";
    _resetSettingsCache();
    const s = getSettings();
    expect(s.llm.apiKey).toBe("sk-override-key");
  });

  it("resolves github.token from env var", () => {
    process.env["GITHUB_TOKEN"] = "ghp_override-token";
    _resetSettingsCache();
    const s = getSettings();
    expect(s.github.token).toBe("ghp_override-token");
  });

  it("resolves lark.webhookUrl from env var", () => {
    process.env["LARK_WEBHOOK_URL"] = "https://open.larksuite.com/hook/abc";
    _resetSettingsCache();
    const s = getSettings();
    expect(s.lark.webhookUrl).toBe("https://open.larksuite.com/hook/abc");
  });

  it("returns undefined for lark.webhookUrl when env var absent", () => {
    delete process.env["LARK_WEBHOOK_URL"];
    _resetSettingsCache();
    const s = getSettings();
    expect(s.lark.webhookUrl).toBeUndefined();
  });

  it("returns the same reference on repeated calls (cached)", () => {
    const a = getSettings();
    const b = getSettings();
    expect(a).toBe(b);
  });
});

describe("validateEnv", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const keys = ["GITHUB_TOKEN", "LLM_BASE_URL", "LLM_API_KEY"];

  beforeEach(() => {
    for (const k of keys) savedEnv[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of keys) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
      else delete process.env[k];
    }
  });

  it("passes when all required vars are set", () => {
    process.env["GITHUB_TOKEN"] = "test-token";
    process.env["LLM_BASE_URL"] = "https://example.com";
    process.env["LLM_API_KEY"] = "test-key";
    expect(() => validateEnv()).not.toThrow();
  });

  it("calls process.exit(1) when GITHUB_TOKEN is missing", () => {
    delete process.env["GITHUB_TOKEN"];
    process.env["LLM_BASE_URL"] = "https://example.com";
    process.env["LLM_API_KEY"] = "test-key";
    const spy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit:1");
    }) as never);
    expect(() => validateEnv()).toThrow("exit:1");
    spy.mockRestore();
  });

  it("calls process.exit(1) when LLM_BASE_URL is missing", () => {
    process.env["GITHUB_TOKEN"] = "test-token";
    delete process.env["LLM_BASE_URL"];
    process.env["LLM_API_KEY"] = "test-key";
    const spy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit:1");
    }) as never);
    expect(() => validateEnv()).toThrow("exit:1");
    spy.mockRestore();
  });

  it("calls process.exit(1) when LLM_API_KEY is missing", () => {
    process.env["GITHUB_TOKEN"] = "test-token";
    process.env["LLM_BASE_URL"] = "https://example.com";
    delete process.env["LLM_API_KEY"];
    const spy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit:1");
    }) as never);
    expect(() => validateEnv()).toThrow("exit:1");
    spy.mockRestore();
  });
});

describe("reloadSafeConfig", () => {
  const baseConfig = {
    llm: {
      model: "test-model",
      baseUrlEnvVar: "LLM_BASE_URL",
      apiKeyEnvVar: "LLM_API_KEY",
      maxTokensPerCall: 4096,
      diffTokenBudget: 8000,
      maxManifestEntries: 100,
    },
    lark: { webhookUrlEnvVar: "LARK_WEBHOOK_URL" },
    github: { tokenEnvVar: "GITHUB_TOKEN" },
    schedule: { dailyCron: "0 9 * * *", weeklyCron: "30 9 * * 1", monthlyCron: "0 10 1 * *", timezone: "UTC" },
    budget: { monthlyCap: 80, warningThreshold: 0.8, cutoffThreshold: 1.0 },
  };

  let tmpPath: string;

  beforeEach(() => {
    tmpPath = join(tmpdir(), `settings-reload-test-${Date.now()}.json`);
    writeFileSync(tmpPath, JSON.stringify(baseConfig));
    _setSettingsConfigPath(tmpPath);
    _resetSettingsCache();
    process.env["LLM_BASE_URL"] = "https://example.com/v1";
    process.env["LLM_API_KEY"] = "sk-test";
    process.env["GITHUB_TOKEN"] = "ghp_test";
  });

  afterEach(() => {
    _resetSettingsCache();
    _setSettingsConfigPath(null);
    try {
      unlinkSync(tmpPath);
    } catch {}
    delete process.env["LLM_BASE_URL"];
    delete process.env["LLM_API_KEY"];
    delete process.env["GITHUB_TOKEN"];
  });

  // Test 1: Successful settings reload — budget change reflected
  it("warm reload reflects updated budget fields in snapshot and getSettings()", () => {
    reloadSafeConfig();
    expect(getSettings().budget.monthlyCap).toBe(80);

    writeFileSync(
      tmpPath,
      JSON.stringify({ ...baseConfig, budget: { monthlyCap: 120, warningThreshold: 0.9, cutoffThreshold: 1.0 } })
    );

    const { snapshot, changed } = reloadSafeConfig();
    expect(snapshot.budget.monthlyCap).toBe(120);
    expect(changed).toBe(true);
    expect(getSettings().budget.monthlyCap).toBe(120);
  });

  // Test 2: Settings JSON parse failure (cache exists) — old cache kept, warning logged
  it("warm reload with invalid JSON keeps old cache and logs a warning", () => {
    reloadSafeConfig();
    const original = getSettings().budget.monthlyCap;

    writeFileSync(tmpPath, "{ not valid json }");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const { snapshot, changed } = reloadSafeConfig();
    expect(changed).toBe(false);
    expect(snapshot.budget.monthlyCap).toBe(original);
    expect(getSettings().budget.monthlyCap).toBe(original);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[config-reload]"));
    warnSpy.mockRestore();
  });

  // Test 3: Settings validation failure (cache exists) — old cache kept
  it("warm reload with invalid safe field type keeps old cache", () => {
    reloadSafeConfig();
    const original = getSettings().budget.monthlyCap;

    writeFileSync(
      tmpPath,
      JSON.stringify({
        ...baseConfig,
        budget: { monthlyCap: "not_a_number", warningThreshold: 0.8, cutoffThreshold: 1.0 },
      })
    );
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const { snapshot, changed } = reloadSafeConfig();
    expect(changed).toBe(false);
    expect(snapshot.budget.monthlyCap).toBe(original);
    warnSpy.mockRestore();
  });

  // Test 4: Settings cold start failure — throws, no stage executed
  it("cold start with invalid JSON throws without initialising Settings", () => {
    writeFileSync(tmpPath, "not json at all");
    expect(() => reloadSafeConfig()).toThrow("[config-reload]");
  });

  // Test 5: Settings cold start success — full Settings initialised
  it("cold start with valid config initialises full Settings object", () => {
    const { snapshot } = reloadSafeConfig();
    expect(snapshot.budget.monthlyCap).toBe(80);
    expect(snapshot.diffTokenBudget).toBe(8000);
    expect(snapshot.maxManifestEntries).toBe(100);
    const s = getSettings();
    expect(s.llm.model).toBe("test-model");
    expect(s.github.token).toBe("ghp_test");
    expect(s.schedule.dailyCron).toBe("0 9 * * *");
    expect(s.schedule.monthlyCron).toBe("0 10 1 * *");
    expect(s.startup.backfill.enabled).toBe(false);
    expect(s.startup.backfill.range).toBe("last7");
  });

  it("cold start reads explicit startup backfill config", () => {
    writeFileSync(
      tmpPath,
      JSON.stringify({
        ...baseConfig,
        startup: { backfill: { enabled: true, range: "month" } },
      })
    );

    reloadSafeConfig();

    const s = getSettings();
    expect(s.startup.backfill.enabled).toBe(true);
    expect(s.startup.backfill.range).toBe("month");
  });

  it("cold start normalizes legacy week startup backfill range to last7", () => {
    writeFileSync(
      tmpPath,
      JSON.stringify({
        ...baseConfig,
        startup: { backfill: { enabled: true, range: "week" } },
      })
    );

    reloadSafeConfig();

    const s = getSettings();
    expect(s.startup.backfill.enabled).toBe(true);
    expect(s.startup.backfill.range).toBe("last7");
  });

  // Test 6: Unsafe fields unchanged on warm reload
  it("warm reload does not mutate llm.model, schedule, or github token", () => {
    reloadSafeConfig();
    const originalModel = getSettings().llm.model;
    const originalCron = getSettings().schedule.dailyCron;
    const originalToken = getSettings().github.token;

    writeFileSync(
      tmpPath,
      JSON.stringify({
        llm: {
          model: "gpt-4o",
          baseUrlEnvVar: "OTHER_BASE_URL",
          apiKeyEnvVar: "OTHER_API_KEY",
          maxTokensPerCall: 8192,
          diffTokenBudget: 12000,
          maxManifestEntries: 200,
        },
        lark: { webhookUrlEnvVar: "OTHER_WEBHOOK" },
        github: { tokenEnvVar: "OTHER_TOKEN" },
        schedule: { dailyCron: "0 10 * * *", weeklyCron: "0 10 * * 1", monthlyCron: "0 10 1 * *", timezone: "America/New_York" },
        budget: { monthlyCap: 100, warningThreshold: 0.8, cutoffThreshold: 1.0 },
      })
    );

    reloadSafeConfig();

    const s = getSettings();
    // Safe fields updated
    expect(s.budget.monthlyCap).toBe(100);
    expect(s.llm.diffTokenBudget).toBe(12000);
    expect(s.llm.maxManifestEntries).toBe(200);
    // Unsafe fields unchanged
    expect(s.llm.model).toBe(originalModel);
    expect(s.schedule.dailyCron).toBe(originalCron);
    expect(s.github.token).toBe(originalToken);
  });
});

describe("getSettings — validation path", () => {
  let tmpPath: string;

  beforeEach(() => {
    tmpPath = join(tmpdir(), `settings-validation-test-${Date.now()}.json`);
    _setSettingsConfigPath(tmpPath);
    _resetSettingsCache();
  });

  afterEach(() => {
    _resetSettingsCache();
    _setSettingsConfigPath(null);
    try {
      unlinkSync(tmpPath);
    } catch {}
  });

  // Regression: getSettings() must throw on invalid safe fields so that when
  // a consumer (e.g. scheduler) calls getSettings() before runPipeline(), an
  // invalid budget.monthlyCap is caught at cold-start — not silently cached and
  // later treated as a warm-reload warning.
  it("throws when budget.monthlyCap is not a number", () => {
    writeFileSync(
      tmpPath,
      JSON.stringify({
        llm: {
          model: "test-model",
          baseUrlEnvVar: "LLM_BASE_URL",
          apiKeyEnvVar: "LLM_API_KEY",
          maxTokensPerCall: 4096,
          diffTokenBudget: 8000,
          maxManifestEntries: 100,
        },
        lark: { webhookUrlEnvVar: "LARK_WEBHOOK_URL" },
        github: { tokenEnvVar: "GITHUB_TOKEN" },
        schedule: { dailyCron: "0 9 * * *", weeklyCron: "30 9 * * 1", monthlyCron: "0 10 1 * *", timezone: "UTC" },
        budget: { monthlyCap: "not_a_number", warningThreshold: 0.8, cutoffThreshold: 1.0 },
      })
    );
    expect(() => getSettings()).toThrow("budget.monthlyCap must be a number");
  });

  it("throws when startup.backfill.enabled is not a boolean", () => {
    writeFileSync(
      tmpPath,
      JSON.stringify({
        llm: {
          model: "test-model",
          baseUrlEnvVar: "LLM_BASE_URL",
          apiKeyEnvVar: "LLM_API_KEY",
          maxTokensPerCall: 4096,
          diffTokenBudget: 8000,
          maxManifestEntries: 100,
        },
        lark: { webhookUrlEnvVar: "LARK_WEBHOOK_URL" },
        github: { tokenEnvVar: "GITHUB_TOKEN" },
        schedule: { dailyCron: "0 9 * * *", weeklyCron: "30 9 * * 1", monthlyCron: "0 10 1 * *", timezone: "UTC" },
        budget: { monthlyCap: 80, warningThreshold: 0.8, cutoffThreshold: 1.0 },
        startup: { backfill: { enabled: "yes", range: "last7" } },
      })
    );
    expect(() => getSettings()).toThrow("startup.backfill.enabled must be a boolean");
  });

  it("throws when startup.backfill.range is invalid", () => {
    writeFileSync(
      tmpPath,
      JSON.stringify({
        llm: {
          model: "test-model",
          baseUrlEnvVar: "LLM_BASE_URL",
          apiKeyEnvVar: "LLM_API_KEY",
          maxTokensPerCall: 4096,
          diffTokenBudget: 8000,
          maxManifestEntries: 100,
        },
        lark: { webhookUrlEnvVar: "LARK_WEBHOOK_URL" },
        github: { tokenEnvVar: "GITHUB_TOKEN" },
        schedule: { dailyCron: "0 9 * * *", weeklyCron: "30 9 * * 1", monthlyCron: "0 10 1 * *", timezone: "UTC" },
        budget: { monthlyCap: 80, warningThreshold: 0.8, cutoffThreshold: 1.0 },
        startup: { backfill: { enabled: true, range: "current_week" } },
      })
    );
    expect(() => getSettings()).toThrow('startup.backfill.range must be "last7" or "month"');
  });
});
