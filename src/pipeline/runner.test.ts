import { describe, it, expect, mock, afterEach } from "bun:test";
import { join } from "node:path";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runPipeline, writeHealthAndMaybeAlert } from "./runner";
import type { PipelineContext, PipelineStage, StageResult } from "./runner";

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
