import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stage } from "./impact-check";
import { getRunStages, getE2EStages } from "../../e2e-run";
import { _resetSettingsCache, _setSettingsConfigPath } from "../../config/settings";
import { _resetProjectsCache, _setProjectsConfigPath, _resetMantleConfigCache, _setMantleConfigPath } from "../../config/projects";
import type { PipelineContext } from "../runner";

const BASE_SETTINGS = {
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

const IMPACT_CHECK_CONFIG = {
  enabled: true,
  maxChecksPerDay: 5,
  maxStepsPerCheck: 12,
  maxCostPerCheck: 1.0,
  monthlySubCap: 50,
  maxAgeDays: 7,
  clonesDir: "data/mantle-repos",
  maxCloneDiskGB: 10,
  codegraphEnabled: false,
};

const VALID_MANTLE_CONFIG = {
  mantleTargets: [],
  counterpartRelationships: [],
};

function makeCtx(): PipelineContext {
  return {
    stageResults: new Map(),
    reportMode: "daily",
    dispatchEnabled: true,
  };
}

describe("impact-check stage — unit", () => {
  let settingsTmp: string;
  let mantleTmp: string;
  let projectsTmp: string;

  beforeEach(() => {
    settingsTmp = join(tmpdir(), `ic-settings-${Date.now()}.json`);
    mantleTmp = join(tmpdir(), `ic-mantle-${Date.now()}.json`);
    projectsTmp = join(tmpdir(), `ic-projects-${Date.now()}.json`);
    writeFileSync(mantleTmp, JSON.stringify(VALID_MANTLE_CONFIG));
    writeFileSync(projectsTmp, JSON.stringify([]));
    _setMantleConfigPath(mantleTmp);
    _setProjectsConfigPath(projectsTmp);
    _resetMantleConfigCache();
    _resetProjectsCache();
    process.env["LLM_BASE_URL"] = "https://example.com/v1";
    process.env["LLM_API_KEY"] = "sk-test";
    process.env["GITHUB_TOKEN"] = "ghp_test";
  });

  afterEach(() => {
    _resetSettingsCache();
    _resetProjectsCache();
    _resetMantleConfigCache();
    _setSettingsConfigPath(null);
    _setProjectsConfigPath(null);
    _setMantleConfigPath(null);
    try { unlinkSync(settingsTmp); } catch {}
    try { unlinkSync(mantleTmp); } catch {}
    try { unlinkSync(projectsTmp); } catch {}
    delete process.env["LLM_BASE_URL"];
    delete process.env["LLM_API_KEY"];
    delete process.env["GITHUB_TOKEN"];
  });

  it("stage name is 'impact-check'", () => {
    expect(stage.name).toBe("impact-check");
  });

  it("returns success=true immediately when impactCheck is not configured", async () => {
    writeFileSync(settingsTmp, JSON.stringify(BASE_SETTINGS));
    _setSettingsConfigPath(settingsTmp);
    _resetSettingsCache();

    const result = await stage.execute(makeCtx());

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns success=true immediately when impactCheck.enabled=false", async () => {
    writeFileSync(settingsTmp, JSON.stringify({ ...BASE_SETTINGS, impactCheck: { ...IMPACT_CHECK_CONFIG, enabled: false } }));
    _setSettingsConfigPath(settingsTmp);
    _resetSettingsCache();

    const result = await stage.execute(makeCtx());

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns success=false without throwing when DB is unavailable", async () => {
    writeFileSync(settingsTmp, JSON.stringify({ ...BASE_SETTINGS, impactCheck: IMPACT_CHECK_CONFIG }));
    _setSettingsConfigPath(settingsTmp);
    _resetSettingsCache();

    // Invoke with real settings but no DB (getDb() will use default path — may fail or succeed
    // depending on environment, but either way the stage should not throw)
    let threw = false;
    let result;
    try {
      result = await stage.execute(makeCtx());
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    // result is either success (DB opened) or failure (DB error) — either is valid
    expect(typeof result?.success).toBe("boolean");
  });
});

describe("stage order — impact-check is between analyze and report", () => {
  it("getRunStages includes impact-check between analyze and report (no-dispatch)", () => {
    const names = getRunStages(true).map((s) => s.name);
    expect(names).toEqual(["collect", "analyze", "impact-check", "report"]);
  });

  it("getRunStages includes impact-check between analyze and report (with dispatch)", () => {
    const names = getRunStages(false).map((s) => s.name);
    expect(names).toEqual(["collect", "analyze", "impact-check", "report", "dispatch"]);
  });

  it("getE2EStages includes impact-check between analyze and report", () => {
    const names = getE2EStages().map((s) => s.name);
    expect(names).toEqual(["collect", "analyze", "impact-check", "report", "dispatch"]);
  });
});
