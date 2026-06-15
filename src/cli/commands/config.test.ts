import { describe, expect, it } from "bun:test";
import { buildConfigShowPayload, configShowCommand } from "./config";

describe("buildConfigShowPayload", () => {
  it("includes the effective impactCheck settings", () => {
    const payload = buildConfigShowPayload(
      {
        llm: {
          model: "test-model",
          baseUrl: "https://llm.example.com",
          apiKey: "sk-test",
          maxTokensPerCall: 4096,
          diffTokenBudget: 8000,
          maxManifestEntries: 100,
        },
        lark: { webhookUrl: "https://lark.example.com/hook" },
        github: { token: "ghp_test" },
        schedule: {
          dailyCron: "0 9 * * *",
          weeklyCron: "30 9 * * 1",
          monthlyCron: "0 10 1 * *",
          timezone: "Asia/Shanghai",
        },
        budget: { monthlyCap: 150, warningThreshold: 0.8, cutoffThreshold: 1.0 },
        impactCheck: {
          enabled: false,
          maxChecksPerDay: 40,
          maxStepsPerCheck: 12,
          maxCostPerCheck: 1,
          monthlySubCap: 50,
          maxAgeDays: 7,
          clonesDir: "data/mantle-repos",
          maxCloneDiskGB: 10,
          codegraphEnabled: false,
        },
      },
      [
        {
          org: "org",
          repo: "repo",
          url: "https://github.com/org/repo",
        },
      ],
      {
        llm: { baseUrlEnvVar: "LLM_BASE_URL", apiKeyEnvVar: "LLM_API_KEY" },
        github: { tokenEnvVar: "GITHUB_TOKEN" },
        lark: { webhookUrlEnvVar: "LARK_WEBHOOK_URL" },
      }
    );

    expect(payload.settings.impactCheck).toMatchObject({
      enabled: false,
      maxChecksPerDay: 40,
      monthlySubCap: 50,
      codegraphEnabled: false,
    });
  });
});

describe("configShowCommand", () => {
  it("rejects unknown sections in JSON mode", async () => {
    const originalLog = console.log;
    console.log = () => {};
    try {
      await expect(configShowCommand(["unknown"], { json: true, verbose: false })).rejects.toThrow(
        'Invalid config section "unknown"'
      );
    } finally {
      console.log = originalLog;
    }
  });
});
