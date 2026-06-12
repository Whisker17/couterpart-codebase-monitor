import { describe, it, expect, mock, spyOn, afterEach, beforeEach } from "bun:test";
import { join } from "node:path";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { writeFileSync, unlinkSync } from "node:fs";
import {
  runPipeline,
  startReadinessHeartbeat,
  writeHealthAndMaybeAlert,
  writeReadiness,
} from "./runner";
import type { PipelineContext, PipelineStage, StageResult } from "./runner";
import { _resetSettingsCache, _setSettingsConfigPath } from "../config/settings";
import { _resetProjectsCache, _setProjectsConfigPath } from "../config/projects";

function makeStage(name: string, override?: Partial<StageResult> | (() => never)): PipelineStage {
  return {
    name,
    execute: async (_ctx: PipelineContext) => {
      if (typeof override === "function") override();
      return {
        success: true,
        itemsProcessed: 1,
        errors: [],
        durationMs: 0,
        ...((typeof override === "object" && override) || {}),
      };
    },
  };
}

function failStage(name: string): PipelineStage {
  return makeStage(name, { success: false, itemsProcessed: 0, errors: [`${name} failed`] });
}

describe("runPipeline", () => {
  it("runs all stages sequentially and returns all results", async () => {
    const results = await runPipeline([
      makeStage("collect"),
      makeStage("analyze"),
      makeStage("report"),
      makeStage("dispatch"),
    ]);

    expect(results.size).toBe(4);
    expect(results.get("collect")?.success).toBe(true);
    expect(results.get("analyze")?.success).toBe(true);
    expect(results.get("report")?.success).toBe(true);
    expect(results.get("dispatch")?.success).toBe(true);
  });

  it("runner measures wall-clock durationMs, ignoring stage-returned 0", async () => {
    const slowStage: PipelineStage = {
      name: "slow",
      execute: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { success: true, itemsProcessed: 1, errors: [], durationMs: 0 };
      },
    };

    const results = await runPipeline([slowStage]);
    expect(results.get("slow")?.durationMs).toBeGreaterThanOrEqual(20);
  });

  it("continues executing subsequent stages when one throws", async () => {
    const throwingStage: PipelineStage = {
      name: "analyze",
      execute: async () => {
        throw new Error("analysis failed");
      },
    };

    const results = await runPipeline([
      makeStage("collect"),
      throwingStage,
      makeStage("report"),
    ]);

    expect(results.get("analyze")?.success).toBe(false);
    expect(results.get("analyze")?.errors).toEqual(["analysis failed"]);
    expect(results.get("report")?.success).toBe(true);
  });

  it("downstream stages can read ctx.stageResults from upstream", async () => {
    let seenCollectResult: StageResult | undefined;

    const reportStage: PipelineStage = {
      name: "report",
      execute: async (ctx: PipelineContext) => {
        seenCollectResult = ctx.stageResults.get("collect");
        return { success: true, itemsProcessed: 0, errors: [], durationMs: 0 };
      },
    };

    await runPipeline([makeStage("collect", { itemsProcessed: 5 }), reportStage]);

    expect(seenCollectResult?.itemsProcessed).toBe(5);
  });

  it("returns empty map for empty stage list", async () => {
    const results = await runPipeline([]);
    expect(results.size).toBe(0);
  });

  it("defaults ctx.reportMode to 'daily' when no options provided", async () => {
    let seenMode: string | undefined;

    const checkStage: PipelineStage = {
      name: "check",
      execute: async (ctx: PipelineContext) => {
        seenMode = ctx.reportMode;
        return { success: true, itemsProcessed: 0, errors: [], durationMs: 0 };
      },
    };

    await runPipeline([checkStage]);
    expect(seenMode).toBe("daily");
  });

  it("propagates reportMode: 'weekly' to stages via context", async () => {
    let seenMode: string | undefined;

    const checkStage: PipelineStage = {
      name: "check",
      execute: async (ctx: PipelineContext) => {
        seenMode = ctx.reportMode;
        return { success: true, itemsProcessed: 0, errors: [], durationMs: 0 };
      },
    };

    await runPipeline([checkStage], { reportMode: "weekly" });
    expect(seenMode).toBe("weekly");
  });
});

describe("writeHealthAndMaybeAlert", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeTmpHealth(): Promise<string> {
    tmpDir = await mkdtemp(join(tmpdir(), "health-test-"));
    return join(tmpDir, "health.json");
  }

  async function readHealth(path: string) {
    return JSON.parse(await Bun.file(path).text());
  }

  it("writes health.json with correct shape after a successful run", async () => {
    const healthPath = await makeTmpHealth();
    const results = new Map<string, StageResult>([
      ["collect", { success: true, itemsProcessed: 5, errors: [], durationMs: 10 }],
      ["analyze", { success: true, itemsProcessed: 5, errors: [], durationMs: 20 }],
    ]);

    await writeHealthAndMaybeAlert(results, { healthJsonPath: healthPath });

    const health = await readHealth(healthPath);
    expect(health.success).toBe(true);
    expect(health.prsProcessed).toBe(5);
    expect(health.errors).toEqual([]);
    expect(health.consecutiveFailures).toBe(0);
    expect(typeof health.lastRun).toBe("string");
  });

  it("increments consecutiveFailures when all stages fail", async () => {
    const healthPath = await makeTmpHealth();
    const failResults = new Map<string, StageResult>([
      ["collect", { success: false, itemsProcessed: 0, errors: ["net err"], durationMs: 5 }],
      ["analyze", { success: false, itemsProcessed: 0, errors: ["no data"], durationMs: 5 }],
    ]);

    await writeHealthAndMaybeAlert(failResults, { healthJsonPath: healthPath });
    const h1 = await readHealth(healthPath);
    expect(h1.consecutiveFailures).toBe(1);

    await writeHealthAndMaybeAlert(failResults, { healthJsonPath: healthPath });
    const h2 = await readHealth(healthPath);
    expect(h2.consecutiveFailures).toBe(2);
  });

  it("resets consecutiveFailures when any stage succeeds", async () => {
    const healthPath = await makeTmpHealth();
    const failResults = new Map<string, StageResult>([
      ["collect", { success: false, itemsProcessed: 0, errors: ["err"], durationMs: 5 }],
    ]);
    const successResults = new Map<string, StageResult>([
      ["collect", { success: true, itemsProcessed: 3, errors: [], durationMs: 5 }],
    ]);

    await writeHealthAndMaybeAlert(failResults, { healthJsonPath: healthPath });
    await writeHealthAndMaybeAlert(failResults, { healthJsonPath: healthPath });
    await writeHealthAndMaybeAlert(successResults, { healthJsonPath: healthPath });

    const h = await readHealth(healthPath);
    expect(h.consecutiveFailures).toBe(0);
    expect(h.success).toBe(true);
  });

  it("calls sendCard when consecutiveFailures reaches threshold", async () => {
    const healthPath = await makeTmpHealth();
    const sentCards: object[] = [];

    mock.module("../extensions/lark-dispatcher/webhook", () => ({
      sendCard: async (_url: string, card: object) => {
        sentCards.push(card);
        return { code: 0, msg: "ok" };
      },
    }));

    const origUrl = process.env.LARK_WEBHOOK_URL;
    process.env.LARK_WEBHOOK_URL = "https://example.com/hook";

    const failResults = new Map<string, StageResult>([
      ["collect", { success: false, itemsProcessed: 0, errors: ["err"], durationMs: 5 }],
      ["analyze", { success: false, itemsProcessed: 0, errors: ["err"], durationMs: 5 }],
    ]);

    try {
      await writeHealthAndMaybeAlert(failResults, { healthJsonPath: healthPath });
      await writeHealthAndMaybeAlert(failResults, { healthJsonPath: healthPath });
      expect(sentCards.length).toBe(0);

      await writeHealthAndMaybeAlert(failResults, { healthJsonPath: healthPath });
      expect(sentCards.length).toBe(1);
    } finally {
      if (origUrl === undefined) delete process.env.LARK_WEBHOOK_URL;
      else process.env.LARK_WEBHOOK_URL = origUrl;
      mock.restore();
    }
  });

  it("does not call sendCard when LARK_WEBHOOK_URL is unset", async () => {
    const healthPath = await makeTmpHealth();
    const sentCards: object[] = [];

    mock.module("../extensions/lark-dispatcher/webhook", () => ({
      sendCard: async (_url: string, card: object) => {
        sentCards.push(card);
        return { code: 0, msg: "ok" };
      },
    }));

    const origUrl = process.env.LARK_WEBHOOK_URL;
    delete process.env.LARK_WEBHOOK_URL;

    const failResults = new Map<string, StageResult>([
      ["collect", { success: false, itemsProcessed: 0, errors: ["err"], durationMs: 5 }],
    ]);

    try {
      for (let i = 0; i < 3; i++) {
        await writeHealthAndMaybeAlert(failResults, { healthJsonPath: healthPath });
      }
      expect(sentCards.length).toBe(0);
    } finally {
      if (origUrl !== undefined) process.env.LARK_WEBHOOK_URL = origUrl;
      mock.restore();
    }
  });
});

describe("writeReadiness", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeTmpFile(fileName: string): Promise<string> {
    if (!tmpDir) tmpDir = await mkdtemp(join(tmpdir(), "readiness-"));
    return join(tmpDir, fileName);
  }

  async function readJson(path: string) {
    return JSON.parse(await Bun.file(path).text());
  }

  it("creates readiness.json for Docker health checks", async () => {
    const readinessPath = await makeTmpFile("readiness.json");
    await writeReadiness(readinessPath);
    const h = await readJson(readinessPath);
    expect(h.status).toBe("ready");
    const age = Date.now() - new Date(h.updatedAt).getTime();
    expect(age).toBeLessThan(5000);
  });

  it("does not rewrite pipeline health.json during startup readiness", async () => {
    const healthPath = await makeTmpFile("health.json");
    const readinessPath = await makeTmpFile("readiness.json");
    const existing = {
      lastRun: new Date().toISOString(),
      success: false,
      prsProcessed: 0,
      errors: ["pipeline failed"],
      consecutiveFailures: 2,
    };
    await Bun.write(healthPath, JSON.stringify(existing));

    await writeReadiness(readinessPath);
    const h = await readJson(healthPath);
    expect(h).toEqual(existing);
  });

  it("refreshes readiness.json on a heartbeat", async () => {
    const readinessPath = await makeTmpFile("readiness.json");
    const timer = await startReadinessHeartbeat(readinessPath, 5);
    try {
      const first = await readJson(readinessPath);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const second = await readJson(readinessPath);
      expect(new Date(second.updatedAt).getTime()).toBeGreaterThan(
        new Date(first.updatedAt).getTime()
      );
    } finally {
      clearInterval(timer);
    }
  });
});

describe("runPipeline — config reload cold start failures", () => {
  const validSettings = {
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
  const validProjects = [{ org: "base", repo: "base", url: "https://github.com/base/base" }];

  let settingsTmp: string;
  let projectsTmp: string;

  beforeEach(() => {
    const os = require("node:os");
    settingsTmp = join(os.tmpdir(), `runner-settings-${Date.now()}.json`);
    projectsTmp = join(os.tmpdir(), `runner-projects-${Date.now()}.json`);
    writeFileSync(settingsTmp, JSON.stringify(validSettings));
    writeFileSync(projectsTmp, JSON.stringify(validProjects));
    _setSettingsConfigPath(settingsTmp);
    _setProjectsConfigPath(projectsTmp);
    _resetSettingsCache();
    _resetProjectsCache();
    process.env["LLM_BASE_URL"] = "https://example.com/v1";
    process.env["LLM_API_KEY"] = "sk-test";
    process.env["GITHUB_TOKEN"] = "ghp_test";
  });

  afterEach(() => {
    _resetSettingsCache();
    _resetProjectsCache();
    _setSettingsConfigPath(null);
    _setProjectsConfigPath(null);
    try {
      unlinkSync(settingsTmp);
    } catch {}
    try {
      unlinkSync(projectsTmp);
    } catch {}
    delete process.env["LLM_BASE_URL"];
    delete process.env["LLM_API_KEY"];
    delete process.env["GITHUB_TOKEN"];
  });

  it("settings cold start failure throws before any stage executes", async () => {
    writeFileSync(settingsTmp, "bad json");
    let executed = false;
    const stage: PipelineStage = {
      name: "test",
      execute: async () => {
        executed = true;
        return { success: true, itemsProcessed: 0, errors: [], durationMs: 0 };
      },
    };
    await expect(runPipeline([stage])).rejects.toThrow("[config-reload]");
    expect(executed).toBe(false);
  });

  it("projects cold start failure is not fatal — stages still run so collect can use the SQLite fallback", async () => {
    writeFileSync(projectsTmp, "bad json");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let executed = false;
    const stage: PipelineStage = {
      name: "test",
      execute: async () => {
        executed = true;
        return { success: true, itemsProcessed: 0, errors: [], durationMs: 0 };
      },
    };
    await runPipeline([stage]);
    expect(executed).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[config-reload]"));
    warnSpy.mockRestore();
  });

});
