/**
 * Shared Jev question wording for Slack respond/observe routing (P2).
 * Keep in sync with edge/eval/p2/question-definitions.json and run-jev-eval.mjs.
 */

export const ROUTER_JEV_MODEL_DEFAULT = "jev-latest";

/** Shadow routing judgments use a short timeout; fail open to current heuristics. */
export const ROUTER_JEV_TIMEOUT_MS_DEFAULT = 1_500;

export type RouterJevRouteSource =
  | "direct_message"
  | "app_mention"
  | "trusted_rich_mention"
  | "thread_reply"
  | "channel_message";

export type RouterJevRouteState = Readonly<{
  message: string;
  source: RouterJevRouteSource;
  channelType: "im" | "mpim" | "channel" | "group" | "unknown";
  botMentioned: boolean;
  hasFiles: boolean;
  /** Recent thread lines the ingress router already has (oldest first). */
  threadContext: readonly string[];
  /** Deterministic code signal: user asked not to use memory / look things up. */
  memoryOptOut: boolean;
}>;

export const ROUTE_CHOICE_INSTRUCTIONS =
  "Should the OpenTag Slack bot send a reply to this message, or only observe the thread without responding?";

export const ROUTE_CHOICE_CRITERIA = {
  respond:
    "The message is directed at the bot or clearly expects a bot reply: explicit mention or DM, a question, an action request, a problem report, a file continuation in an active bot thread, or similar task-oriented language.",
  observe:
    "The bot should listen only: side chatter between humans, phatic noise, messages clearly aimed at someone else, or an explicit instruction not to reply.",
} as const;

export const NEEDS_HUMAN_INSTRUCTIONS =
  "Should a human teammate handle this message instead of the OpenTag bot?";

export const NEEDS_HUMAN_CRITERIA = {
  true:
    "The sender asks for a real person, escalates to billing/legal/HR/security, reports harassment or a safety issue, or needs human judgment the bot must not take.",
  false:
    "A normal bot-handlable question, task, status check, or conversational turn the triage agent can address.",
} as const;

export const MEMORY_NEEDED_INSTRUCTIONS =
  "Would answering this message benefit from retrieving long-term workspace memory or knowledge (past Slack threads, wiki pages, or code)?";

export const MEMORY_NEEDED_CRITERIA = {
  true:
    "The message references prior team decisions, internal docs or code, a specific past thread, or other workspace-specific facts not contained in the message itself.",
  false:
    "General knowledge, greetings, acknowledgments, or a self-contained question answerable without workspace retrieval.",
} as const;

const MEMORY_OPT_OUT_PATTERN =
  /\b(?:without\s+using\s+memory|without\s+memory|don['\u2019]?t\s+look\s+anything\s+up|don['\u2019]?t\s+(?:use|look\s+up|lookup|search|retrieve)\s+(?:memory|anything|wiki|slack|code)|do\s+not\s+look\s+anything\s+up|do\s+not\s+(?:use|look\s+up|lookup|search|retrieve)\s+(?:memory|anything|wiki|slack|code)|no\s+memory|from\s+general\s+knowledge\s+only)\b/i;

/**
 * Deterministic override for edge/AGENTS.md rule 7. We detect explicit opt-out in
 * code (not only via Jev) so shadow logs stay truthful even when the model
 * disagrees, and production can gate prefetch without trusting model compliance.
 */
export function detectMemoryOptOut(message: string): boolean {
  return MEMORY_OPT_OUT_PATTERN.test(message);
}

export function buildRouterJevRouteState(input: {
  message: string;
  source: RouterJevRouteSource;
  channelType?: string;
  botMentioned?: boolean;
  hasFiles?: boolean;
  threadContext?: readonly string[];
}): RouterJevRouteState {
  const channelType = normalizeChannelType(input.channelType);
  const botMentioned = input.botMentioned === true ||
    input.source === "app_mention" ||
    input.source === "direct_message" ||
    input.source === "trusted_rich_mention";
  const message = input.message.trim();
  return Object.freeze({
    message,
    source: input.source,
    channelType,
    botMentioned,
    hasFiles: input.hasFiles === true,
    threadContext: Object.freeze((input.threadContext ?? []).map((line) => line.trim()).filter(Boolean)),
    memoryOptOut: detectMemoryOptOut(message),
  });
}

function normalizeChannelType(value?: string): RouterJevRouteState["channelType"] {
  switch (value) {
    case "im":
      return "im";
    case "mpim":
      return "mpim";
    case "channel":
      return "channel";
    case "group":
      return "group";
    default:
      return "unknown";
  }
}

export function buildRouterJevRouteQuestions(): Record<string, unknown> {
  return {
    route: {
      type: "choice",
      instructions: ROUTE_CHOICE_INSTRUCTIONS,
      criteria: ROUTE_CHOICE_CRITERIA,
    },
    needsHuman: {
      type: "noul",
      instructions: NEEDS_HUMAN_INSTRUCTIONS,
      criteria: NEEDS_HUMAN_CRITERIA,
    },
    memoryNeeded: {
      type: "noul",
      instructions: MEMORY_NEEDED_INSTRUCTIONS,
      criteria: MEMORY_NEEDED_CRITERIA,
    },
  };
}

/** JSON artifact consumed by edge/eval/p2/run-jev-eval.mjs (no repo imports). */
export function routerJevQuestionDefinitionsArtifact(): Record<string, unknown> {
  return Object.freeze({
    schemaVersion: 1,
    modelDefault: ROUTER_JEV_MODEL_DEFAULT,
    timeoutMsDefault: ROUTER_JEV_TIMEOUT_MS_DEFAULT,
    memoryOptOutPattern: MEMORY_OPT_OUT_PATTERN.source,
    questions: buildRouterJevRouteQuestions(),
  });
}
