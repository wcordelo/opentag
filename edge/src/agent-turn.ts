/**
 * Shared bundled agent turn — used by onMention and `/agent`.
 * Kept separate from bot-engine to avoid circular imports with commands.
 */
import {
  ALL_EDGE_TOOLS,
  ALL_EDGE_TOOL_NAMES,
  guardToolsByBundle,
} from "./tools/index.js";
import { resolveAllowedTools } from "./config/access-bundle.js";
import { loadTurnAccess } from "./config/workspace-config-do.js";
import { getCurrentTeamId } from "./request-context.js";
import type { Env } from "./env.js";
import type { AgentContentPart } from "./slack/download-files.js";

type Requester = {
  id?: string;
  name?: string;
  handle?: string;
  email?: string;
};

type AgentThread = {
  conversationKey?: string;
  post: (ui: never) => Promise<unknown>;
  runAgent: (opts: {
    prompt: string | AgentContentPart[];
    context?: Array<{ description: string; value: string }>;
    tools?: ReturnType<typeof guardToolsByBundle>;
  }) => Promise<unknown>;
};

function channelFromThread(thread: { conversationKey?: string }): string {
  return (thread.conversationKey ?? "").split("::")[0] ?? "";
}

export async function runBundledAgentTurn(
  env: Env,
  thread: AgentThread,
  prompt: string | AgentContentPart[],
  requester?: Requester,
): Promise<void> {
  const teamId = getCurrentTeamId();
  const channelId = channelFromThread(thread);

  const { config, bundle } = await loadTurnAccess(
    env.WORKSPACE_CONFIG,
    teamId,
    channelId,
  );
  const allowed = new Set(
    resolveAllowedTools([...ALL_EDGE_TOOL_NAMES], bundle),
  );

  if (config.policies.allowMemoryWrite === false) {
    allowed.delete("memory_write");
  }
  if (config.policies.allowTasks === false) {
    allowed.delete("start_task");
    allowed.delete("research_progress");
  }

  const toolContext = [
    { description: "systemPrompt", value: config.systemPrompt },
    { description: "accessBundleId", value: bundle.id },
    {
      description: "allowedTools",
      value: JSON.stringify([...allowed]),
    },
    {
      description: "secretRefs",
      value: JSON.stringify(bundle.secretRefs),
    },
    {
      description: "mcpEndpoints",
      value: JSON.stringify(bundle.mcpEndpoints),
    },
    { description: "teamId", value: teamId },
    { description: "channelId", value: channelId },
    {
      description: "Requesting Slack user",
      value: JSON.stringify({
        id: requester?.id ?? "",
        name: requester?.name ?? requester?.handle ?? "",
        email: requester?.email ?? "",
        handle: requester?.handle ?? "",
      }),
    },
  ];

  await thread.runAgent({
    prompt,
    context: toolContext,
    tools: guardToolsByBundle(
      ALL_EDGE_TOOLS.filter((t) => allowed.has(t.name)),
      allowed,
    ),
  });
}
