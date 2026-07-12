/**
 * Research agent backend — procedural Orchestrator/Researcher/Verifier pipeline.
 *
 * Exposes POST /api/copilotkit/agent/research/run
 */
import "dotenv/config";
import { createServer } from "node:http";
import {
  BuiltInAgent,
  CopilotSseRuntime,
  convertInputToTanStackAI,
} from "@copilotkit/runtime/v2";
import { createCopilotNodeListener } from "@copilotkit/runtime/v2/node";
import { chat } from "@tanstack/ai";
import { openaiText } from "@tanstack/ai-openai";
import { createResearchContext } from "./lib/research/index.js";
import type { ThreadMessage } from "./lib/research/types.js";

const ctxPromise = createResearchContext();

const RESEARCH_SYSTEM = [
  "You are a research coordinator. When the user asks for research, acknowledge",
  "that deep research has been started and will post results to the thread.",
  "Do not invent research results — the background pipeline handles that.",
].join("\n");

const model = (process.env["RESEARCH_MODEL"] ?? "openai/gpt-4o-mini").replace(
  /^openai\//,
  "",
) as Parameters<typeof openaiText>[0];

const agent = new BuiltInAgent({
  type: "tanstack",
  factory: async (runCtx) => {
    const { messages, systemPrompts, tools: clientTools } =
      convertInputToTanStackAI(runCtx.input);

    const ctx = await ctxPromise;
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const objective =
      typeof lastUser?.content === "string"
        ? lastUser.content
        : "Research the topic discussed";

    // Extract thread context from client tools / context
    const threadContext = extractThreadContext(runCtx.input);
    const threadKey = extractThreadKey(runCtx.input);
    const channelId = extractChannelId(runCtx.input);
    const eventId = extractProp(runCtx.input, "eventId") as string | undefined;

    const result = await ctx.orchestrator.handleMention({
      threadKey: threadKey ?? `thread_${Date.now()}`,
      objective: stripResearchPrefix(objective),
      threadContext,
      channelId,
      eventId,
    });

    const ackMessage =
      result.status === "continuing"
        ? `Research started (task \`${result.taskId}\`). I'll post updates and a final summary in this thread.`
        : result.status === "complete"
          ? `Research complete for task \`${result.taskId}\`.`
          : `Research could not start: ${result.message ?? "unknown error"}`;

    return chat({
      adapter: openaiText(model),
      messages: [
        ...messages,
        { role: "assistant", content: ackMessage },
      ],
      systemPrompts: [RESEARCH_SYSTEM, ...systemPrompts],
      tools: clientTools as never[],
      abortController: runCtx.abortController,
    });
  },
});

function stripResearchPrefix(text: string): string {
  return text.replace(/^\s*research\s+/i, "").trim() || text;
}

function extractThreadContext(input: unknown): ThreadMessage[] | undefined {
  const ctx = extractProp(input, "threadContext");
  if (Array.isArray(ctx)) return ctx as ThreadMessage[];
  return undefined;
}

function extractThreadKey(input: unknown): string | undefined {
  return extractProp(input, "threadKey") as string | undefined;
}

function extractChannelId(input: unknown): string | undefined {
  return extractProp(input, "channelId") as string | undefined;
}

function extractProp(input: unknown, key: string): unknown {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  if (key in obj) return obj[key];
  const forwarded = obj["forwardedProps"] as Record<string, unknown> | undefined;
  if (forwarded && key in forwarded) return forwarded[key];
  const context = obj["context"] as Array<{ description?: string; value?: unknown }> | undefined;
  if (context) {
    const entry = context.find((c) => c.description === key);
    if (entry) return entry.value;
  }
  return undefined;
}

const runtime = new CopilotSseRuntime({
  agents: { research: agent },
});

const listener = createCopilotNodeListener({
  runtime,
  basePath: "/api/copilotkit",
  cors: true,
});

const port = Number(process.env["RESEARCH_PORT"] ?? 8201);
createServer(listener).listen(port, () => {
  console.log(
    `[research-runtime] listening on http://localhost:${port}/api/copilotkit/agent/research/run`,
  );
});

// Process outbox periodically
setInterval(async () => {
  try {
    const ctx = await ctxPromise;
    const deliveries = await ctx.orchestrator.getPendingDeliveries();
    // Deliveries are consumed by the bot via polling endpoint
    void deliveries;
  } catch (err) {
    console.error("[research-runtime] outbox poll error", err);
  }
}, 5000);

// HTTP endpoint for bot to poll deliveries and process outbox
const deliveryServer = createServer(async (req, res) => {
  if (req.url?.startsWith("/api/research/deliveries")) {
    const url = new URL(req.url, `http://localhost:${port}`);
    const threadKey = url.searchParams.get("threadKey") ?? undefined;
    const ctx = await ctxPromise;
    const deliveries = await ctx.orchestrator.getPendingDeliveries(threadKey ?? undefined);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(deliveries));
    return;
  }

  // POST /api/research/deliveries/:id/delivered — mirrors OrchestratorDO.
  const deliveredMatch = req.url?.match(
    /^\/api\/research\/deliveries\/([^/]+)\/delivered\/?$/,
  );
  if (deliveredMatch && req.method === "POST") {
    const id = deliveredMatch[1];
    if (id) {
      const ctx = await ctxPromise;
      await ctx.orchestrator.markDeliveryDelivered(id);
    }
    res.writeHead(200);
    res.end("ok");
    return;
  }

  if (req.url?.startsWith("/api/research/process-outbox") && req.method === "POST") {
    const ctx = await ctxPromise;
  const body = await readBody(req);
  const { sessionId } = JSON.parse(body || "{}") as { sessionId?: string };
    if (sessionId) await ctx.orchestrator.processOutbox(sessionId);
    res.writeHead(200);
    res.end("ok");
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

deliveryServer.listen(port + 1, () => {
  console.log(`[research-runtime] delivery API on http://localhost:${port + 1}`);
});

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}
