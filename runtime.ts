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
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
    executionControl: { register: registerExecutionControl },
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

type ActiveRun = {
  request: IncomingMessage;
  response: ServerResponse;
  controller?: AbortController;
  quiesced: Promise<void>;
  settle: () => void;
};
const activeRuns = new Map<string, ActiveRun>();

function settleRun(executionId: string, run: ActiveRun): void {
  if (activeRuns.get(executionId) === run) activeRuns.delete(executionId);
  run.settle();
}

function registerExecutionControl(
  executionId: string,
  controller: AbortController,
): () => void {
  const run = activeRuns.get(executionId);
  if (!run) {
    controller.abort("execution_request_already_closed");
    return () => {};
  }
  run.controller = controller;
  return () => settleRun(executionId, run);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const controlledListener = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const path = new URL(request.url ?? "/", "http://runtime").pathname;
  if (request.method === "POST" && path === "/opentag/control/interrupt") {
    try {
      const body = await readJson(request) as { executionId?: unknown };
      const executionId = typeof body.executionId === "string" ? body.executionId : "";
      if (!executionId) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ accepted: false, quiescent: false }));
        return;
      }
      const active = activeRuns.get(executionId);
      if (active) {
        active.controller?.abort("opentag_exact_interrupt");
        if (!active.controller) active.request.destroy();
        active.response.destroy();
        await active.quiesced;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ executionId, accepted: true, quiescent: true }));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ accepted: false, quiescent: false }));
    }
    return;
  }

  const executionId = request.headers["x-opentag-execution-id"];
  if (typeof executionId !== "string" || !executionId) {
    listener(request, response);
    return;
  }
  let settle!: () => void;
  const quiesced = new Promise<void>((resolve) => { settle = resolve; });
  const run: ActiveRun = { request, response, quiesced, settle };
  const responseClosed = () => {
    if (run.controller) {
      run.controller.abort("execution_response_closed");
    } else {
      settleRun(executionId, run);
    }
  };
  response.once("finish", responseClosed);
  response.once("close", responseClosed);
  activeRuns.set(executionId, run);
  listener(request, response);
};

const port = Number(process.env["PORT"] ?? 8200);
createServer((request, response) => {
  void controlledListener(request, response);
}).listen(port, () => {
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
