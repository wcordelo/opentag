/**
 * Bundle allowlist helpers (no Workers/DO imports — unit-test friendly).
 */
import type { BotTool } from "@copilotkit/channels";

export function guardToolsByBundle<T extends BotTool>(
  tools: ReadonlyArray<T>,
  allowed: ReadonlySet<string>,
): T[] {
  return tools.map((tool) => {
    if (allowed.has(tool.name)) return tool;
    return {
      ...tool,
      async handler() {
        return `⛔ Tool \`${tool.name}\` is not allowed by this channel's access bundle.`;
      },
    } as T;
  });
}
