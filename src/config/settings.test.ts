import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { getSettings, validateEnv, _resetSettingsCache } from "./settings.ts";

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
    expect(s.llm.model).toBe("claude-sonnet-4-6");
    expect(s.llm.diffTokenBudget).toBe(8000);
    expect(s.llm.maxManifestEntries).toBe(100);
    expect(s.llm.maxTokensPerCall).toBe(4096);
    expect(s.budget.monthlyCap).toBe(80);
    expect(s.budget.warningThreshold).toBe(0.8);
    expect(typeof s.schedule.dailyCron).toBe("string");
    expect(typeof s.schedule.weeklyCron).toBe("string");
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
