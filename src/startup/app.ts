import { runWithPipelineLock } from "../pipeline/runner";

export interface StartupAgent {
  state: { tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: unknown }> }> };
}

export interface AppStartupDeps<TModel = unknown> {
  validateEnv: () => void;
  getDb: () => unknown;
  runStartupBackfillIfNeeded: () => Promise<void>;
  buildModel: () => TModel;
  createAgent: (model: TModel) => StartupAgent;
  registerHello: (agent: StartupAgent) => void;
  startReadinessHeartbeat: () => Promise<unknown>;
  registerScheduler: () => void;
  log: (...args: unknown[]) => void;
}

export async function runAppStartup<TModel>(deps: AppStartupDeps<TModel>): Promise<void> {
  deps.validateEnv();
  deps.getDb();

  await deps.startReadinessHeartbeat();

  const model = deps.buildModel();
  const agent = deps.createAgent(model);
  deps.registerHello(agent);
  deps.registerHello(agent); // second call must not duplicate tools (hot-reload idempotency check)
  if (agent.state.tools.filter((t) => t.name === "hello-world").length !== 1) {
    throw new Error("register() idempotency check failed: duplicate tool entries");
  }

  deps.log("pi-agent initialized. Registered tools:", agent.state.tools.map((t) => t.name));

  const helloTool = agent.state.tools.find((t) => t.name === "hello-world");
  if (!helloTool) throw new Error("hello-world tool not registered");

  const result = await helloTool.execute("validate-0", {}, undefined, undefined);
  deps.log("hello-world result:", result.details);

  deps.log("Session ready. Hot-reload: modify a handler and re-register the extension to pick up changes.");

  deps.registerScheduler();
  void runWithPipelineLock(() => deps.runStartupBackfillIfNeeded()).catch((err: unknown) => {
    deps.log(
      "[startup-backfill] Background startup backfill failed after readiness:",
      err instanceof Error ? err.message : String(err)
    );
  });
}
