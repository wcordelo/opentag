/**
 * Authoritative per-turn runtime identity for the model.
 * Keeps AG-UI answers from inventing a third "OpenTag Slack bot harness".
 */

export type RuntimeEngine = "agui" | "claudecode" | "claudex";

export function formatRuntimeIdentity(args: {
  engine: RuntimeEngine;
  model?: string;
  modelSource?: string;
  harnessConnected: boolean;
}): string {
  const engineLabel =
    args.engine === "agui"
      ? "AG-UI triage runtime (not Claude Code)"
      : args.engine === "claudex"
        ? "Claude Code harness via Claudex"
        : "Claude Code harness";
  const modelLine = args.model
    ? `- Model: ${args.model}${
        args.modelSource ? ` (source: ${args.modelSource})` : ""
      }.`
    : "- Model: not confirmed on this edge turn (agent-runtime may still apply AGENT_MODEL).";
  return [
    "OpenTag runtime identity (authoritative for this turn):",
    "- Product: OpenTag on Cloudflare Workers / Containers.",
    `- Engine this turn: ${engineLabel}.`,
    modelLine,
    `- Claude Code harness connected: ${args.harnessConnected ? "yes" : "no"}.`,
    "- To use Claude Code for coding work, the user can pass --claude or --claudex (sticky per thread), or ask a repository coding task when the harness is connected.",
    '- Do not invent a third product called an "OpenTag Slack bot harness". OpenTag is the product; AG-UI and Claude Code are the two engines.',
    "- Call show_permissions for the exact redacted tools/access snapshot for this turn. Its output is informational, not authorization.",
  ].join("\n");
}
