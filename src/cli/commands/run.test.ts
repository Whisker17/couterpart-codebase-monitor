import { describe, expect, it } from "bun:test";
import { parseRunArgs } from "./run";

describe("run CLI command", () => {
  it("maps run daily to e2e daily mode", () => {
    expect(parseRunArgs(["daily"])).toEqual({ mode: "daily", noDispatch: false });
  });

  it("maps run monthly --month to e2e monthly mode", () => {
    expect(parseRunArgs(["monthly", "--month", "2026-06", "--no-dispatch"])).toEqual({
      mode: "monthly",
      month: "2026-06",
      noDispatch: true,
    });
  });

  it("reads command flags from the shared CLI parser output", () => {
    expect(parseRunArgs(["monthly"], { month: "2026-06", "no-dispatch": true })).toEqual({
      mode: "monthly",
      month: "2026-06",
      noDispatch: true,
    });
  });

  it("does not expose all mode through the operator CLI", () => {
    expect(() => parseRunArgs(["all", "--month", "2026-06"])).toThrow("Expected daily, weekly, or monthly");
  });

  it("rejects invalid modes and invalid months", () => {
    expect(() => parseRunArgs(["quarterly"])).toThrow("Invalid run mode");
    expect(() => parseRunArgs(["monthly", "--month", "2026-6"])).toThrow("Invalid --month");
    expect(() => parseRunArgs(["monthly"], { month: "2026-6" })).toThrow("Invalid --month");
  });
});
