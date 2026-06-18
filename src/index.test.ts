import { describe, expect, it } from "bun:test";
import { runWithPipelineLock } from "./pipeline/runner";
import { runAppStartup } from "./startup/app";

describe("runAppStartup", () => {
  it("starts readiness and scheduler without waiting for startup backfill to finish", async () => {
    const events: string[] = [];
    let backfillStarted = false;
    let releaseBackfill!: () => void;

    try {
      await runAppStartup({
        validateEnv: () => events.push("validate"),
        getDb: () => {
          events.push("db");
          return {};
        },
        runStartupBackfillIfNeeded: () => {
          backfillStarted = true;
          events.push("backfill-start");
          return new Promise<void>((resolve) => {
            releaseBackfill = resolve;
          });
        },
        buildModel: () => ({ provider: "test" }),
        createAgent: () => ({
          state: { tools: [{ name: "hello-world", execute: async () => ({ details: "ok" }) }] },
        }),
        registerHello: () => events.push("hello"),
        startReadinessHeartbeat: async () => {
          events.push("readiness");
          return undefined;
        },
        registerScheduler: () => events.push("scheduler"),
        log: () => {},
      });

      expect(backfillStarted).toBe(true);
      expect(events).toContain("readiness");
      expect(events).toContain("scheduler");
      expect(events.indexOf("readiness")).toBeLessThan(events.indexOf("backfill-start"));
    } finally {
      releaseBackfill?.();
    }
  });

  it("contains startup backfill rejections after the app is ready", async () => {
    const errors: string[] = [];

    await runAppStartup({
      validateEnv: () => {},
      getDb: () => ({}),
      runStartupBackfillIfNeeded: async () => {
        throw new Error("inspection failed");
      },
      buildModel: () => ({ provider: "test" }),
      createAgent: () => ({
        state: { tools: [{ name: "hello-world", execute: async () => ({ details: "ok" }) }] },
      }),
      registerHello: () => {},
      startReadinessHeartbeat: async () => undefined,
      registerScheduler: () => {},
      log: (...args) => errors.push(args.map(String).join(" ")),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors.some((line) => line.includes("inspection failed"))).toBe(true);
  });

  it("runs startup backfill through the shared pipeline lock", async () => {
    const events: string[] = [];
    let releasePipeline!: () => void;
    const pipelineStarted = new Promise<void>((resolve) => {
      void runWithPipelineLock(async () => {
        events.push("pipeline-start");
        resolve();
        await new Promise<void>((release) => {
          releasePipeline = release;
        });
        events.push("pipeline-end");
      });
    });

    try {
      await pipelineStarted;

      await runAppStartup({
        validateEnv: () => {},
        getDb: () => ({}),
        runStartupBackfillIfNeeded: async () => {
          events.push("backfill-start");
        },
        buildModel: () => ({ provider: "test" }),
        createAgent: () => ({
          state: { tools: [{ name: "hello-world", execute: async () => ({ details: "ok" }) }] },
        }),
        registerHello: () => {},
        startReadinessHeartbeat: async () => undefined,
        registerScheduler: () => {},
        log: () => {},
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual(["pipeline-start"]);

      releasePipeline();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual(["pipeline-start", "pipeline-end", "backfill-start"]);
    } finally {
      releasePipeline?.();
    }
  });
});
