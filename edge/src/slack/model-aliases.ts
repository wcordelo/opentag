/**
 * Shared Claude model aliases for message flags and channel runtime defaults.
 * Keep message-parser and channel-default maps in lockstep.
 */
export const CLAUDE_MODEL_ALIASES: Readonly<Record<string, string>> = {
  fable: "claude-fable-5",
  haiku: "claude-haiku-4-5-20251001",
  opus: "claude-opus-4-8",
  "opus-5": "claude-opus-5",
  "opus-5-fast": "claude-opus-5-fast",
  sonnet: "claude-sonnet-5",
};

export function expandClaudeModelAlias(value: string): string {
  return CLAUDE_MODEL_ALIASES[value.toLowerCase()] ?? value;
}
