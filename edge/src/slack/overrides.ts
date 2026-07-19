/**
 * Inline message directives, restored from the v1 slackbot:
 *   --claude | --claude-code                         pick the harness for the thread
 *   --claudex                                       run Claude Code through CLIProxyAPI/Codex
 *   --model <name> (or --model=<name>)              pick the model within that harness
 *   --codex                                         rejected: use the Claude Code `--claudex` mode
 *   -rsn                                            rejected: reasoning is operator-controlled
 *   --fable | --opus | --sonnet | --haiku           model shortcuts (imply claude-code)
 *
 * Flags are stripped from the text before it reaches the agent. The harness
 * applies at session creation — an explicit harness flag on a thread pinned to
 * another harness restarts the thread on the requested one. Harness/model
 * choices are sticky at the Slack thread level: the last flag wins for later
 * turns in the same thread. `--model` accepts either a full model id
 * (claude-sonnet-5, claude-opus-4-8, ...), or a Claude alias
 * (fable/opus/sonnet/haiku) which expands to the full id. Unsupported provider
 * and reasoning flags are stripped but returned as errors so callers can reject
 * the turn before persisting a preference or invoking a runtime.
 */

export type MessageOverrides = {
  cleanedText: string
  harnessType?: string
  model?: string
  reasoning?: string
  errors: string[]
}

// Flag name -> HarnessType wire value (serde lowercase of the Rust enum).
const HARNESS_FLAGS: Record<string, string> = {
  claude: 'claudecode',
  'claude-code': 'claudecode',
  claudecode: 'claudecode',
  claudex: 'claudex'
}

// Claude model aliases, usable both as bare flags (--opus) and as --model
// values (--model opus). Bare-flag form also implies the claude-code harness.
const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  fable: 'claude-fable-5',
  haiku: 'claude-haiku-4-5-20251001',
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5'
}

const MODEL_SHORTCUTS: Record<string, { harnessType: string; model: string }> =
  Object.fromEntries(
    Object.entries(CLAUDE_MODEL_ALIASES).map(([alias, model]) => [
      alias,
      { harnessType: 'claudecode', model }
    ])
  )

// Values are one horizontal-whitespace-delimited token; a newline after the
// value starts the user's prompt, not part of the model/reasoning value.
const MODEL_VALUE_SEPARATOR = String.raw`(?:[^\S\r\n]*=[^\S\r\n]*|[^\S\r\n]+)`
const FLAG_VALUE_BOUNDARY = String.raw`(?=[^\S\r\n]|\r?\n|\r|<br\s*/?>|$)`

const MODEL_FLAG_PATTERN = new RegExp(
  String.raw`(?:^|\s)--model${MODEL_VALUE_SEPARATOR}([A-Za-z0-9._/-]+)${FLAG_VALUE_BOUNDARY}`,
  'i'
)

// Single dash by design: a short per-turn knob (`-rsn high`), so it can't reuse
// the `--`-prefixed flagPattern() helper. Value-capturing like --model.
const REASONING_FLAG_PATTERN = new RegExp(
  String.raw`(?:^|\s)-rsn${MODEL_VALUE_SEPARATOR}([A-Za-z-]+)${FLAG_VALUE_BOUNDARY}`,
  'i'
)

// Codex reasoning efforts (turn/start `effort`), plus convenience aliases.
const REASONING_EFFORTS: Record<string, string> = {
  none: 'none',
  minimal: 'minimal',
  min: 'minimal',
  low: 'low',
  medium: 'medium',
  med: 'medium',
  high: 'high',
  hi: 'high',
  xhigh: 'xhigh',
  xhi: 'xhigh',
  'x-high': 'xhigh',
  max: 'max'
}

export function extractMessageOverrides(text: string): MessageOverrides {
  let cleaned = text
  let harnessType: string | undefined
  let model: string | undefined
  let reasoning: string | undefined
  const errors: string[] = []

  const modelMatch = MODEL_FLAG_PATTERN.exec(cleaned)
  if (modelMatch) {
    const value = modelMatch[1]!
    model = CLAUDE_MODEL_ALIASES[value.toLowerCase()] ?? value
    if (value.includes('/')) {
      errors.push(`provider-qualified model ${value} is unsupported; use --claudex with a GPT model or --claude with a Claude model`)
    }
    harnessType = /^gpt-/i.test(value) ? 'claudex' : 'claudecode'
    cleaned = stripMatch(cleaned, modelMatch)
  }

  const reasoningMatch = REASONING_FLAG_PATTERN.exec(cleaned)
  if (reasoningMatch) {
    const normalized = REASONING_EFFORTS[reasoningMatch[1]!.toLowerCase()]
    if (normalized) {
      reasoning = normalized
      errors.push(`-rsn ${normalized} is unsupported; Claudex reasoning effort is controlled by the proxy configuration`)
    } else {
      errors.push(`unsupported reasoning effort: ${reasoningMatch[1]!}`)
    }
    cleaned = stripMatch(cleaned, reasoningMatch)
  }

  const codexMatch = flagPattern('codex').exec(cleaned)
  if (codexMatch) {
    errors.push('--codex is unsupported; use --claudex to run Claude Code with a Codex-backed model')
    cleaned = stripMatch(cleaned, codexMatch)
  }

  for (const [flag, harness] of Object.entries(HARNESS_FLAGS)) {
    const match = flagPattern(flag).exec(cleaned)
    if (!match) continue
    harnessType = harness
    cleaned = stripMatch(cleaned, match)
  }

  for (const [flag, shortcut] of Object.entries(MODEL_SHORTCUTS)) {
    const match = flagPattern(flag).exec(cleaned)
    if (!match) continue
    model ??= shortcut.model
    harnessType ??= shortcut.harnessType
    cleaned = stripMatch(cleaned, match)
  }

  const result = {
    cleanedText: cleaned === text ? text : cleaned.trim(),
    harnessType,
    model,
    reasoning
  } as MessageOverrides
  Object.defineProperty(result, 'errors', { value: errors, enumerable: false })
  return result
}

function flagPattern(flag: string): RegExp {
  return new RegExp(`(?:^|\\s)--${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'i')
}

function stripMatch(text: string, match: RegExpExecArray): string {
  const before = text.slice(0, match.index)
  const after = text
    .slice(match.index + match[0].length)
    .replace(/^(?:(?:\r\n?|\n)+|<br\s*\/?>)+/i, '')
  const separator =
    before && after && !/\s$/.test(before) && !/^\s/.test(after) ? ' ' : ''
  return `${before}${separator}${after}`
}
