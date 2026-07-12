/**
 * Agent backend for the Slack triage assistant.
 *
 * Local / Container entry: Node HTTP + CopilotKit AG-UI.
 * Shared agent factory: `lib/triage-agent.ts`.
 *
 * Exposed route (the bridge's `AGENT_URL`):
 *   POST http://localhost:8200/api/copilotkit/agent/triage/run
 */
import "dotenv/config";
import { createServer } from "node:http";
import { CopilotSseRuntime } from "@copilotkit/runtime/v2";
import { createCopilotNodeListener } from "@copilotkit/runtime/v2/node";
import { createTriageAgent, type TriageAgentEnv } from "./lib/triage-agent.js";

function envFromProcess(): TriageAgentEnv {
  return {
    LINEAR_TEAM_KEY: process.env["LINEAR_TEAM_KEY"],
    LINEAR_API_KEY: process.env["LINEAR_API_KEY"],
    LINEAR_MCP_URL: process.env["LINEAR_MCP_URL"],
    NOTION_MCP_AUTH_TOKEN: process.env["NOTION_MCP_AUTH_TOKEN"],
    NOTION_MCP_URL: process.env["NOTION_MCP_URL"],
    AGENT_MODEL: process.env["AGENT_MODEL"],
    getSecret: (name) => process.env[name],
  };
}

const agentEnv = envFromProcess();
if (!agentEnv.LINEAR_API_KEY && !agentEnv.NOTION_MCP_AUTH_TOKEN) {
  console.warn(
    "[slack-runtime] No MCP servers configured via env. Set LINEAR_API_KEY and/or " +
      "NOTION_MCP_AUTH_TOKEN in .env — channel bundles may still add mcpEndpoints.",
  );
}

const agent = createTriageAgent(agentEnv);
const runtime = new CopilotSseRuntime({
  agents: { triage: agent },
});

const listener = createCopilotNodeListener({
  runtime,
  basePath: "/api/copilotkit",
  cors: true,
});

const port = Number(process.env["PORT"] ?? 8200);
createServer(listener).listen(port, () => {
  console.log(
    `[slack-runtime] listening on http://localhost:${port}/api/copilotkit/agent/triage/run`,
  );
  console.log(
    `[slack-runtime] default Linear team: ${agentEnv.LINEAR_TEAM_KEY?.trim() || "Berendo"}`,
  );
  const connected = [
    agentEnv.LINEAR_API_KEY ? "Linear" : null,
    agentEnv.NOTION_MCP_AUTH_TOKEN ? "Notion" : null,
  ].filter(Boolean);
  console.log(
    `[slack-runtime] agent "triage" ready · MCP: ${
      connected.length ? connected.join(", ") : "none"
    }`,
  );
});
