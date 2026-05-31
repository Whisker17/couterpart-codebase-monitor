import { describe, expect, it } from "bun:test";
import {
  getE2EStages,
  getExitCode,
  parseOptions,
  getRunStages,
  getPipelineReportMode,
  getModeNotImplementedMessage,
} from "./e2e-run";
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

describe("parseOptions", () => {
  it("defaults to daily mode with dispatch enabled", () => {
    expect(parseOptions([])).toEqual({ mode: "daily", noDispatch: false });
  });

  it("parses --mode daily", () => {
    expect(parseOptions(["--mode", "daily"])).toEqual({ mode: "daily", noDispatch: false });
  });

  it("parses --mode weekly", () => {
    expect(parseOptions(["--mode", "weekly"])).toEqual({ mode: "weekly", noDispatch: false });
  });

  it("parses --mode monthly", () => {
    expect(parseOptions(["--mode", "monthly"])).toEqual({ mode: "monthly", noDispatch: false });
  });

  it("parses --mode all", () => {
    expect(parseOptions(["--mode", "all"])).toEqual({ mode: "all", noDispatch: false });
  });

  it("parses --no-dispatch", () => {
    expect(parseOptions(["--no-dispatch"])).toEqual({ mode: "daily", noDispatch: true });
  });

  it("parses combined --mode all --no-dispatch", () => {
    expect(parseOptions(["--mode", "all", "--no-dispatch"])).toEqual({
      mode: "all",
      noDispatch: true,
    });
  });

  it("parses --no-dispatch before --mode", () => {
    expect(parseOptions(["--no-dispatch", "--mode", "weekly"])).toEqual({
      mode: "weekly",
      noDispatch: true,
    });
  });

  it("ignores unknown flags", () => {
    expect(parseOptions(["--foo", "--mode", "weekly"])).toEqual({
      mode: "weekly",
      noDispatch: false,
    });
  });

  it("ignores invalid mode values", () => {
    expect(parseOptions(["--mode", "invalid"])).toEqual({ mode: "daily", noDispatch: false });
  });
});

describe("getRunStages", () => {
  it("returns 4 stages when dispatch is enabled", () => {
    expect(getRunStages(false).map((s) => s.name)).toEqual([
      "collect",
      "analyze",
      "report",
      "dispatch",
    ]);
  });

  it("returns 3 stages without dispatch when noDispatch is true", () => {
    expect(getRunStages(true).map((s) => s.name)).toEqual(["collect", "analyze", "report"]);
  });
});

describe("getPipelineReportMode", () => {
  it("maps 'all' to 'weekly' since weekly covers daily+weekly", () => {
    expect(getPipelineReportMode("all")).toBe("weekly");
  });

  it("passes through 'daily'", () => {
    expect(getPipelineReportMode("daily")).toBe("daily");
  });

  it("passes through 'weekly'", () => {
    expect(getPipelineReportMode("weekly")).toBe("weekly");
  });
});

describe("getModeNotImplementedMessage", () => {
  it("returns null for daily", () => {
    expect(getModeNotImplementedMessage("daily")).toBeNull();
  });

  it("returns null for weekly", () => {
    expect(getModeNotImplementedMessage("weekly")).toBeNull();
  });

  it("returns null for all", () => {
    expect(getModeNotImplementedMessage("all")).toBeNull();
  });

  it("returns error message for monthly", () => {
    const msg = getModeNotImplementedMessage("monthly");
    expect(msg).not.toBeNull();
    expect(msg).toContain("[E2E]");
    expect(msg).toContain("Monthly mode is not implemented");
  });
});
