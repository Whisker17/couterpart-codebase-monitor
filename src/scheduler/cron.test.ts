import { afterEach, describe, expect, it, mock } from "bun:test";

const cronJobs: Array<{ expression: string; callback: () => Promise<void> }> = [];
const runPipelineCalls: Array<{ stages: string[]; options?: { reportMode?: string; timezone?: string; skipDailyReport?: boolean } }> = [];

mock.module("croner", () => ({
  Cron: class MockCron {
    constructor(expression: string, _options: unknown, callback: () => Promise<void>) {
      cronJobs.push({ expression, callback });
    }
  },
}));

mock.module("../config/settings", () => ({
  getSettings: () => ({
    schedule: {
      dailyCron: "0 9 * * *",
      weeklyCron: "30 9 * * 1",
      monthlyCron: "0 10 1 * *",
      timezone: "UTC",
    },
    budget: {
      monthlyCap: 80,
      warningThreshold: 0.8,
      cutoffThreshold: 1.0,
    },
  }),
}));

mock.module("../pipeline/runner", () => ({
  runPipeline: async (
    stages: Array<{ name: string }>,
    options?: { reportMode?: string; timezone?: string; skipDailyReport?: boolean }
  ) => {
    runPipelineCalls.push({ stages: stages.map((stage) => stage.name), options });
    return new Map();
  },
}));

const { registerScheduler } = await import("./cron");

afterEach(() => {
  cronJobs.length = 0;
  runPipelineCalls.length = 0;
});

describe("registerScheduler", () => {
  it("monthly cron runs report and dispatch only", async () => {
    registerScheduler();

    const monthly = cronJobs.find((job) => job.expression === "0 10 1 * *");
    expect(monthly).toBeDefined();

    await monthly!.callback();

    expect(runPipelineCalls).toHaveLength(1);
    expect(runPipelineCalls[0]).toEqual({
      stages: ["report", "dispatch"],
      options: { reportMode: "monthly", timezone: "UTC", skipDailyReport: true },
    });
  });
});
