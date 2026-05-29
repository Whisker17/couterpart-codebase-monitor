import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { validateEnv } from "./config/settings.ts";
import { getDb } from "./storage/db";
import { register as registerHello } from "./extensions/hello/index.ts";
import { registerScheduler } from "./scheduler/cron";

function buildModel() {
  const baseModel = getModel("anthropic", "claude-sonnet-4-20250514");
  const baseUrl = process.env.LLM_BASE_URL;
  return baseUrl ? { ...baseModel, baseUrl } : baseModel;
}

async function main() {
  validateEnv();
  getDb();

  const model = buildModel();
  const agent = new Agent({
    initialState: { model, systemPrompt: "Counterpart Monitor agent." },
    getApiKey: () =>
      process.env.LLM_BASE_URL && process.env.LLM_API_KEY ? process.env.LLM_API_KEY : undefined,
  });

  // Load extensions. Each extension receives the agent and registers its tools.
  registerHello(agent);
  registerHello(agent); // second call must not duplicate tools (hot-reload idempotency check)
  if (agent.state.tools.filter((t) => t.name === "hello-world").length !== 1) {
    throw new Error("register() idempotency check failed: duplicate tool entries");
  }

  console.log("pi-agent initialized. Registered tools:", agent.state.tools.map((t) => t.name));

  // Validate hello-world tool by calling its execute function directly.
  const helloTool = agent.state.tools.find((t) => t.name === "hello-world");
  if (!helloTool) throw new Error("hello-world tool not registered");

  const result = await helloTool.execute("validate-0", {}, undefined, undefined);
  console.log("hello-world result:", result.details);

  console.log("Session ready. Hot-reload: modify a handler and re-register the extension to pick up changes.");

  registerScheduler();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
