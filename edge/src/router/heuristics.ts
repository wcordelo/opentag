export type RouterHeuristicTier = 1 | 2;

export type RouterSurfaceFeatures = Readonly<{
  hasCodeBlock: boolean;
  hasQuotedText: boolean;
  wordCount: number;
  matchedTier1Pattern: boolean;
  matchedTier2Pattern: boolean;
  tier3Flag: boolean;
}>;

export type RouterHeuristicDecision = Readonly<{
  version: "v1";
  tierDecided: RouterHeuristicTier | null;
  classifierPath: "heuristic" | "model_required";
  matchedRule: string | null;
  matchedRules: readonly string[];
  tier3Flag: boolean;
  surfaceFeatures: RouterSurfaceFeatures;
  reason:
    | "single_tier1_family"
    | "single_tier2_family"
    | "mixed_signal"
    | "no_heuristic_match"
    | "code_veto";
}>;

export type NormalizedRouterText = Readonly<{
  text: string;
  hasCodeBlock: boolean;
  hasQuotedText: boolean;
  wordCount: number;
}>;

type Rule = Readonly<{ id: string; pattern: RegExp }>;

const BOT_MENTION = /<@[a-z0-9]+(?:\|[^>]+)?>/gi;
const CODE_BLOCK = /```[\s\S]*?(?:```|$)/g;
const COURTESY_PREFIX = /^(?:(?:please|can you|could you|would you|pls)\s+)+/;
const CONSTRUCTION_WORD =
  /\b(?:build|run|deploy|execute|migrate|rebuild|fix|debug|investigate|patch|write|draft|create|make|generate|compose|open|file|analyze|compare|review|audit|add|remove|update|change|rename|delete)\b/;
const LONG_RUNNING_VERB = /^(build|run|deploy|execute|migrate|rebuild)\b/;
const CLAUSE_BOUNDARY = /(?:\b(?:and|then)\s+|[,;]\s*)/g;

const TIER1_RULES: readonly Rule[] = [
  { id: "t1.01", pattern: /^(what|when|why|how|where|who|which)\b/ },
  { id: "t1.02", pattern: /^(what did we|what was|what's our)\b/ },
  { id: "t1.03", pattern: /^who knows( about)?\b/ },
  { id: "t1.04", pattern: /^where (is|are|was|does|do|can i find)\b/ },
  { id: "t1.05", pattern: /^(did we|have we|has anyone)\b/ },
  { id: "t1.06", pattern: /^(summarize|recap|catch me up on|tl;?dr)\b/ },
  { id: "t1.07", pattern: /^(when did|when was|when do)\b/ },
  { id: "t1.08", pattern: /^(link|find|show) (me )?(the|that|our)\b/ },
  { id: "t1.12", pattern: /^(search|look up|lookup|retrieve|query)\b/ },
  {
    id: "t1.09",
    pattern: /^(update me on|give me an update on|any update on|status on|status of)\b/,
  },
  {
    id: "t1.11",
    pattern: /^(tell me|explain|describe|remind me)\b.*\b(what|how|why|who|where|when|about)\b/,
  },
];

const TIER2_RULES: readonly Rule[] = [
  { id: "t2.01", pattern: /^(build|run|deploy|execute|migrate|rebuild)\b/ },
  { id: "t2.02", pattern: /^(fix|debug|investigate|patch)\b/ },
  { id: "t2.03", pattern: /^(write|draft|create|make|generate|compose)\b/ },
  {
    id: "t2.04",
    pattern: /^(open|file|create)\s+(a\s+|the\s+)?(pr|ticket|issue)\b/,
  },
  { id: "t2.05", pattern: /^(analyze|compare|review|audit)\b/ },
  {
    id: "t2.06",
    pattern: /^(add|remove|update|change|rename|delete)\b(?!\s+(me|us)\b)/,
  },
];

function wordCount(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

function countBullets(lines: readonly string[]): number {
  return lines.filter((line) =>
    /^\s*(?:[-*•]|\d+[.)])\s+/.test(line),
  ).length;
}

function clauseCandidates(text: string): readonly string[] {
  const candidates = [text];
  for (const boundary of text.matchAll(CLAUSE_BOUNDARY)) {
    candidates.push(text.slice((boundary.index ?? 0) + boundary[0].length));
  }
  return candidates;
}

function matchesRule(rule: Rule, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => rule.pattern.test(candidate));
}

function matchingTier2Rules(
  text: string,
  hasLongSpec: boolean,
): readonly string[] {
  const candidates = clauseCandidates(text);
  const matched = TIER2_RULES
    .filter((rule) => matchesRule(rule, candidates))
    .map((rule) => rule.id);
  return hasLongSpec ? [...matched, "t2.07"] : matched;
}

function prepareRouterText(raw: string): NormalizedRouterText & { bulletCount: number } {
  const withMentionsRemoved = raw.replace(BOT_MENTION, " ");
  const hasCodeBlock = CODE_BLOCK.test(withMentionsRemoved);
  CODE_BLOCK.lastIndex = 0;
  const withoutCode = withMentionsRemoved.replace(CODE_BLOCK, " ");
  const lines = withoutCode.split(/\r?\n/);
  const hasQuotedText = lines.some((line) => /^\s*>/.test(line));
  const withoutQuotes = lines
    .filter((line) => !/^\s*>/.test(line))
    .join(" ");
  const text = withoutQuotes
    .toLowerCase()
    .replace(COURTESY_PREFIX, "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    text,
    hasCodeBlock,
    hasQuotedText,
    wordCount: wordCount(text),
    bulletCount: countBullets(lines.filter((line) => !/^\s*>/.test(line))),
  };
}

export function normalizeRouterText(raw: string): NormalizedRouterText {
  const { bulletCount: _bulletCount, ...normalized } = prepareRouterText(raw);
  return normalized;
}

export function classifyRouterHeuristics(raw: string): RouterHeuristicDecision {
  const normalized = prepareRouterText(raw);
  const tier1Rules = TIER1_RULES
    .filter((rule) => rule.pattern.test(normalized.text))
    .map((rule) => rule.id);
  if (
    normalized.text.endsWith("?") &&
    normalized.wordCount <= 15 &&
    !CONSTRUCTION_WORD.test(normalized.text)
  ) {
    tier1Rules.push("t1.10");
  }
  const hasLongSpec =
    normalized.wordCount > 80 &&
    (normalized.bulletCount >= 3 ||
      /\bacceptance criteria\b|\brequirements\s*:/.test(normalized.text));
  const tier2Rules = matchingTier2Rules(normalized.text, hasLongSpec);
  const tier3Flag =
    hasLongSpec ||
    clauseCandidates(normalized.text).some((candidate) => LONG_RUNNING_VERB.test(candidate));
  const matchedTier1Pattern = tier1Rules.length > 0;
  const matchedTier2Pattern = tier2Rules.length > 0;
  const surfaceFeatures: RouterSurfaceFeatures = {
    hasCodeBlock: normalized.hasCodeBlock,
    hasQuotedText: normalized.hasQuotedText,
    wordCount: normalized.wordCount,
    matchedTier1Pattern,
    matchedTier2Pattern,
    tier3Flag,
  };
  const base = {
    version: "v1" as const,
    tier3Flag,
    surfaceFeatures,
  };
  if (matchedTier1Pattern && matchedTier2Pattern) {
    return {
      ...base,
      tierDecided: null,
      classifierPath: "model_required",
      matchedRule: null,
      matchedRules: [...tier1Rules, ...tier2Rules],
      reason: "mixed_signal",
    };
  }
  if (matchedTier1Pattern) {
    if (normalized.hasCodeBlock) {
      return {
        ...base,
        tierDecided: null,
        classifierPath: "model_required",
        matchedRule: null,
        matchedRules: tier1Rules,
        reason: "code_veto",
      };
    }
    return {
      ...base,
      tierDecided: 1,
      classifierPath: "heuristic",
      matchedRule: tier1Rules[0] ?? null,
      matchedRules: tier1Rules,
      reason: "single_tier1_family",
    };
  }
  if (matchedTier2Pattern) {
    return {
      ...base,
      tierDecided: 2,
      classifierPath: "heuristic",
      matchedRule: tier2Rules[0] ?? null,
      matchedRules: tier2Rules,
      reason: "single_tier2_family",
    };
  }
  return {
    ...base,
    tierDecided: null,
    classifierPath: "model_required",
    matchedRule: null,
    matchedRules: [],
    reason: "no_heuristic_match",
  };
}
