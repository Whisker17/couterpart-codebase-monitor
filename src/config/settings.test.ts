import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";

describe("getSettings", () => {
  it("returns complete Settings object", async () => {
    const { getSettings } = await import("./settings.ts");
    const s = getSettings();

    expect(typeof s.llm.model).toBe("string");
    expect(s.llm.model.length).toBeGreaterThan(0);
    expect(typeof s.llm.diffTokenBudget).toBe("number");
    expect(s.llm.diffTokenBudget).toBeGreaterThan(0);
    expect(typeof s.llm.maxManifestEntries).toBe("number");
    expect(s.llm.maxManifestEntries).toBeGreaterThan(0);
    expect(typeof s.llm.maxTokensPerCall).toBe("number");
    expect(typeof s.lark.webhookUrlEnvVar).toBe("string");
    expect(typeof s.github.tokenEnvVar).toBe("string");
    expect(typeof s.schedule.dailyCron).toBe("string");
    expect(typeof s.schedule.weeklyCron).toBe("string");
    expect(typeof s.budget.monthlyCap).toBe("number");
    expect(typeof s.budget.warningThreshold).toBe("number");
    expect(typeof s.budget.cutoffThreshold).toBe("number");
  });

  it("returns expected defaults", async () => {
    const { getSettings } = await import("./settings.ts");
    const s = getSettings();

    expect(s.llm.model).toBe("claude-sonnet-4-6");
    expect(s.llm.diffTokenBudget).toBe(8000);
    expect(s.llm.maxManifestEntries).toBe(100);
    expect(s.llm.maxTokensPerCall).toBe(4096);
    expect(s.budget.monthlyCap).toBe(80);
    expect(s.budget.warningThreshold).toBe(0.8);
  });

  it("returns the same reference on repeated calls (cached)", async () => {
    const { getSettings } = await import("./settings.ts");
    const a = getSettings();
    const b = getSettings();
    expect(a).toBe(b);
  });
});

describe("validateEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    for (const key of ["GITHUB_TOKEN", "LLM_BASE_URL", "LLM_API_KEY"]) {
      if (key in originalEnv) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("passes when all required vars are set", async () => {
    process.env["GITHUB_TOKEN"] = "test-token";
    process.env["LLM_BASE_URL"] = "https://example.com";
    process.env["LLM_API_KEY"] = "test-key";

    const { validateEnv } = await import("./settings.ts");
    expect(() => validateEnv()).not.toThrow();
  });

  it("calls process.exit(1) when GITHUB_TOKEN is missing", async () => {
    delete process.env["GITHUB_TOKEN"];
    process.env["LLM_BASE_URL"] = "https://example.com";
    process.env["LLM_API_KEY"] = "test-key";

    const exitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    const { validateEnv } = await import("./settings.ts");
    expect(() => validateEnv()).toThrow("process.exit called");
    exitSpy.mockRestore();
  });

  it("calls process.exit(1) when LLM_BASE_URL is missing", async () => {
    process.env["GITHUB_TOKEN"] = "test-token";
    delete process.env["LLM_BASE_URL"];
    process.env["LLM_API_KEY"] = "test-key";

    const exitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    const { validateEnv } = await import("./settings.ts");
    expect(() => validateEnv()).toThrow("process.exit called");
    exitSpy.mockRestore();
  });

  it("calls process.exit(1) when LLM_API_KEY is missing", async () => {
    process.env["GITHUB_TOKEN"] = "test-token";
    process.env["LLM_BASE_URL"] = "https://example.com";
    delete process.env["LLM_API_KEY"];

    const exitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    const { validateEnv } = await import("./settings.ts");
    expect(() => validateEnv()).toThrow("process.exit called");
    exitSpy.mockRestore();
  });
});
