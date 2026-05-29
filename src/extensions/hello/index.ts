import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

const helloWorldTool: AgentTool = {
  name: "hello-world",
  label: "Hello World",
  description: "Returns the current timestamp and status. Used to verify the extension system is working.",
  parameters: Type.Object({}),
  execute: async (_toolCallId, _params) => {
    const result = { time: new Date().toISOString(), status: "ok" };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      details: result,
    };
  },
};

export function register(agent: Agent): void {
  agent.state.tools = (agent.state.tools ?? []).filter((t) => t.name !== helloWorldTool.name);
  agent.state.tools.push(helloWorldTool);
}
