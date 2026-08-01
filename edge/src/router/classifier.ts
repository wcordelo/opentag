/**
 * Versioned v1 request classifier from ROUTER-SPEC.md §3.2.
 *
 * Phase one intentionally ships the cheap heuristic layer only. Ambiguous
 * traffic remains Tier 2; no model call or dispatch side effect belongs in
 * this pure module. The caller may record the result in shadow mode while
 * preserving today's agent path.
 */

export const ROUTER_PATTERN_TABLE_VERSION = "v1" as const;

export type RouterTier = 1 | 2 | 3;
export type RouterClassifierPath =
  | "explicit_command"
  | "hard_gate"
  | "heuristic"
  | "classifier_failed";
export type RouterPrimarySignal =
  | "retrieval_verb"
  | "construction_verb"
  | "question_form"
  | "code_present"
  | "long_spec_form"
  | "conversational"
  | "explicit_hint"
  | "history_continuation"
  | "other";

export type RouterSurfaceFeatures = Readonly<{
  hasCodeBlock: boolean;
  hasAttachment: boolean;
  wordCount: number;
  matchedTier1Pattern: boolean;
  matchedTier2Pattern: boolean;
  tier3Flag: boolean;
}>;

export type RouterClassification = Readonly<{
  tier: RouterTier;
  confidence: number;
  classifierPath: RouterClassifierPath;
  matchedRule: string;
  primarySignal: RouterPrimarySignal;
  surfaceFeatures: RouterSurfaceFeatures;
  normalizedMessage: string;
}>;

const MAX_MESSAGE_LENGTH = 1_000;
const CONSTRUCTION_VERBS = [
  "build", "run", "deploy", "execute", "migrate", "rebuild",
  "fix", "debug", "investigate", "patch", "write", "draft", "create",
  "make", "generate", "compose", "open", "file", "analyze", "compare",
  "review", "audit", "add", "remove", "update", "change", "rename", "delete",
] as const;
const LONG_RUNNING_VERBS = new Set(["run", "deploy", "execute", "migrate", "rebuild"]);

function withoutExcludedText(message: string): { text: string; hasCodeBlock: boolean } {
  const hasCodeBlock = /```[\s\S]*```/.test(message);
  const withoutCode = message.replace(/```[\s\S]*?```/g, " ");
  const withoutQuotes = withoutCode
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join(" ");
  return { text: withoutQuotes, hasCodeBlock };
}

function normalizeMessage(message: string): { text: string; hasCodeBlock: boolean } {
  const bounded = message.slice(0, MAX_MESSAGE_LENGTH);
  const excluded = withoutExcludedText(bounded);
  let text = excluded.text
    .toLocaleLowerCase()
    .replace(/^\s*<@[a-z0-9]+>\s*/i, "")
    .replace(/^(please |can you |could you |would you |pls )+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return { text, hasCodeBlock: excluded.hasCodeBlock };
}

function wordCount(text: string): number {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function clauseStarts(text: string): string[] {
  const starts = [text];
  // The start anchor is already represented by `starts`; keeping it out of
  // the global expression avoids a zero-length RegExp match loop.
  const boundary = /(?:\b(?:and|then)\b|[,;])\s*/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text)) !== null) {
    const start = match.index + match[0].length;
    if (start < text.length) starts.push(text.slice(start));
  }
  return starts;
}

function tier1Rule(text: string): string | undefined {
  const rules: Array<[string, RegExp]> = [
    ["t1.01", /^(what|when|why|how|where|who|which)\b/],
    ["t1.02", /^(what did we|what was|what's our)\b/],
    ["t1.03", /^who knows( about)?\b/],
    ["t1.04", /^where (is|are|was|does|do|can i find)\b/],
    ["t1.05", /^(did we|have we|has anyone)\b/],
    ["t1.06", /^(summarize|recap|catch me up on|tl;?dr)\b/],
    ["t1.07", /^(when did|when was|when do)\b/],
    ["t1.08", /^(link|find|show) (me )?(the|that|our)\b/],
    ["t1.09", /^(update me on|give me an update on|any update on|status on|status of)\b/],
    ["t1.10", /^(tell me|explain|describe|remind me)\s+(what|how|why|who|where|when|about)\b/],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0];
}

function constructionRule(text: string): { rule?: string; tier3Flag: boolean } {
  const starts = clauseStarts(text);
  for (const start of starts) {
    if (/^(open|file|create) (a |the )?(pr|ticket|issue)\b/.test(start)) {
      return { rule: "t2.05", tier3Flag: false };
    }
    const match = /^(build|run|deploy|execute|migrate|rebuild|fix|debug|investigate|patch|write|draft|create|make|generate|compose|analyze|compare|review|audit|add|remove|update|change|rename|delete)\b/.exec(start);
    if (!match) continue;
    const verb = match[1]!;
    if (["add", "remove", "update", "change", "rename", "delete"].includes(verb) &&
        /^(update|add|remove|change|rename|delete) (me|us)\b/.test(start)) {
      continue;
    }
    const rule = LONG_RUNNING_VERBS.has(verb) ? "t2.01" :
      ["fix", "debug", "investigate", "patch"].includes(verb) ? "t2.02" :
      ["write", "draft", "create", "make", "generate", "compose"].includes(verb) ? "t2.03" :
      ["analyze", "compare", "review", "audit"].includes(verb) ? "t2.06" : "t2.07";
    return { rule, tier3Flag: LONG_RUNNING_VERBS.has(verb) };
  }
  const bulletCount = (text.match(/(?:^|\s)(?:[-*]|\d+[.)])\s+/g) ?? []).length;
  const longSpec = wordCount(text) > 80 &&
    (bulletCount >= 3 || /\b(acceptance criteria|requirements):/i.test(text));
  return longSpec ? { rule: "t2.08", tier3Flag: true } : { tier3Flag: false };
}

function explicitCommand(text: string): { tier: RouterTier; rule: string } | undefined {
  if (/^\/ask\b/.test(text)) return { tier: 1, rule: "command.ask" };
  if (/^\/task\b/.test(text)) return { tier: 3, rule: "command.task" };
  return undefined;
}

export function classifyRouterMessage(input: {
  message: string;
  hasAttachment?: boolean;
  activeSession?: boolean;
}): RouterClassification {
  const normalized = normalizeMessage(input.message);
  const words = wordCount(normalized.text);
  const explicit = explicitCommand(normalized.text);
  const construction = constructionRule(normalized.text);
  const questionRule = normalized.text.endsWith("?") && words <= 15 &&
    !CONSTRUCTION_VERBS.some((verb) => new RegExp(`\\b${verb}\\b`).test(normalized.text));
  const tier1RuleId = tier1Rule(normalized.text) ?? (questionRule ? "t1.11" : undefined);
  const tier2RuleId = construction.rule;
  const features: RouterSurfaceFeatures = Object.freeze({
    hasCodeBlock: normalized.hasCodeBlock,
    hasAttachment: input.hasAttachment === true,
    wordCount: words,
    matchedTier1Pattern: Boolean(tier1RuleId),
    matchedTier2Pattern: Boolean(tier2RuleId),
    tier3Flag: construction.tier3Flag || explicit?.tier === 3,
  });

  if (input.activeSession) {
    return Object.freeze({
      tier: 2,
      confidence: 1,
      classifierPath: "hard_gate",
      matchedRule: "active_session",
      primarySignal: "history_continuation",
      surfaceFeatures: features,
      normalizedMessage: normalized.text,
    });
  }
  if (explicit) {
    return Object.freeze({
      tier: explicit.tier,
      confidence: 1,
      classifierPath: "explicit_command",
      matchedRule: explicit.rule,
      primarySignal: explicit.tier === 1 ? "retrieval_verb" : "construction_verb",
      surfaceFeatures: features,
      normalizedMessage: normalized.text,
    });
  }

  // Code-bearing retrieval questions are intentionally ambiguous and go to
  // the model/default Tier 2 path rather than claiming a Tier 1 answer.
  if (tier1RuleId && !tier2RuleId && normalized.hasCodeBlock) {
    return Object.freeze({
      tier: 2,
      confidence: 0,
      classifierPath: "classifier_failed",
      matchedRule: "code_veto",
      primarySignal: "code_present",
      surfaceFeatures: features,
      normalizedMessage: normalized.text,
    });
  }
  if (tier1RuleId && !tier2RuleId) {
    return Object.freeze({
      tier: 1,
      confidence: 1,
      classifierPath: "heuristic",
      matchedRule: tier1RuleId,
      primarySignal: questionRule ? "question_form" : "retrieval_verb",
      surfaceFeatures: features,
      normalizedMessage: normalized.text,
    });
  }
  if (tier2RuleId && !tier1RuleId) {
    return Object.freeze({
      tier: 2,
      confidence: 1,
      classifierPath: "heuristic",
      matchedRule: tier2RuleId,
      primarySignal: construction.rule === "t2.08" ? "long_spec_form" : "construction_verb",
      surfaceFeatures: features,
      normalizedMessage: normalized.text,
    });
  }
  // Mixed families and phatic/unknown messages are intentionally conservative.
  return Object.freeze({
    tier: 2,
    confidence: 0,
    classifierPath: "classifier_failed",
    matchedRule: tier1RuleId && tier2RuleId ? "mixed_signal" : "unresolved",
    primarySignal: "conversational",
    surfaceFeatures: features,
    normalizedMessage: normalized.text,
  });
}
