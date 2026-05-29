import { describe, it, expect } from "bun:test";
import { runPipeline } from "./runner";
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
