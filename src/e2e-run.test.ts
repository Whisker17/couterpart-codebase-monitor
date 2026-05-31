import { describe, expect, it } from "bun:test";
import { getE2EStages, getExitCode } from "./e2e-run";
import type { StageResult } from "./pipeline/runner";

function result(success: boolean): StageResult {
  return { success, itemsProcessed: 0, errors: success ? [] : ["failed"], durationMs: 0 };
}

describe("e2e-run", () => {
  it("runs collect, analyze, report, and dispatch in order", () => {
    expect(getE2EStages().map((stage) => stage.name)).toEqual([
      "collect",
      "analyze",
      "report",
      "dispatch",
    ]);
  });

  it("returns exit code 1 when any stage failed", () => {
    const results = new Map<string, StageResult>([
      ["collect", result(true)],
      ["analyze", result(true)],
      ["report", result(true)],
      ["dispatch", result(false)],
    ]);

    expect(getExitCode(results)).toBe(1);
  });

  it("returns exit code 0 when every stage succeeded", () => {
    const results = new Map<string, StageResult>([
      ["collect", result(true)],
      ["analyze", result(true)],
      ["report", result(true)],
      ["dispatch", result(true)],
    ]);

    expect(getExitCode(results)).toBe(0);
  });
});
