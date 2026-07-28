/**
 * Web UI planner → executor → synthesis pipeline (K2 Phase 5).
 * Same retrieval primitives as MCP/Slack; UI owns orchestration.
 */

import type { KnowledgeCitationBase } from "../memory/knowledge-contract.js";
import { unifiedKnowledgeSearch, type SearchListFn } from "../memory/retrieval/unified-search.js";

export type KnowledgeToolName =
  | "search"
  | "search_slack"
  | "search_wiki"
  | "search_code"
  | "search_custom"
  | "recent_prs"
  | "who_knows";

export type PlannerLlm = (input: {
  query: string;
  projectId: string;
  availableTools: KnowledgeToolName[];
}) => Promise<KnowledgeToolName[]>;

export type SynthesisLlm = (input: {
  query: string;
  evidence: KnowledgeCitationBase[];
}) => Promise<{ answer: string; citationKeys: string[] }>;

export type WebUiQueryInput = {
  query: string;
  projectId: string;
  availableTools: KnowledgeToolName[];
  /** Pre-bound search list factories keyed by tool name. */
  listFactories: Partial<Record<KnowledgeToolName, SearchListFn>>;
  planner: PlannerLlm;
  synthesizer: SynthesisLlm;
  perListLimit?: number;
  finalLimit?: number;
};

export type WebUiQueryResult = {
  toolsUsed: KnowledgeToolName[];
  evidence: KnowledgeCitationBase[];
  answer: string;
  citationKeys: string[];
};

/**
 * Planner selects tools → executor fans out → synthesizer answers with citations.
 */
export async function runWebUiKnowledgeQuery(
  input: WebUiQueryInput,
): Promise<WebUiQueryResult> {
  const selected = await input.planner({
    query: input.query,
    projectId: input.projectId,
    availableTools: input.availableTools,
  });
  const toolsUsed = selected.filter(
    (tool) => input.availableTools.includes(tool) && input.listFactories[tool],
  );
  const lists = toolsUsed
    .map((tool) => input.listFactories[tool])
    .filter((fn): fn is SearchListFn => typeof fn === "function");

  const evidence = lists.length === 0
    ? []
    : await unifiedKnowledgeSearch({
        query: input.query,
        lists,
        perListLimit: input.perListLimit ?? 8,
        rrfK: 60,
        finalLimit: input.finalLimit ?? 10,
      });

  const synthesis = await input.synthesizer({
    query: input.query,
    evidence,
  });

  return {
    toolsUsed,
    evidence,
    answer: synthesis.answer,
    citationKeys: synthesis.citationKeys,
  };
}

/** Deterministic planner fallback when no LLM is configured. */
export function defaultKnowledgePlanner(input: {
  query: string;
  projectId: string;
  availableTools: KnowledgeToolName[];
}): KnowledgeToolName[] {
  const q = input.query.toLowerCase();
  const picked: KnowledgeToolName[] = [];
  const prefer = (name: KnowledgeToolName) => {
    if (input.availableTools.includes(name) && !picked.includes(name)) picked.push(name);
  };
  if (/\b(pr|pull request|commit)\b/.test(q)) prefer("recent_prs");
  if (/\b(who|expert|owner|knows)\b/.test(q)) prefer("who_knows");
  if (/\b(code|function|repo|file|stack\s*trace)\b/.test(q)) prefer("search_code");
  if (/\b(wiki|confluence|runbook|doc)\b/.test(q)) prefer("search_wiki");
  if (/\b(slack|thread|channel|said)\b/.test(q)) prefer("search_slack");
  if (picked.length === 0) prefer("search");
  if (picked.length === 0) prefer("search_slack");
  return picked;
}

export function synthesizeFromEvidence(input: {
  query: string;
  evidence: KnowledgeCitationBase[];
}): { answer: string; citationKeys: string[] } {
  if (input.evidence.length === 0) {
    return {
      answer: "I could not find supporting evidence in the knowledge base for that question.",
      citationKeys: [],
    };
  }
  const lines = input.evidence.map((c, i) => {
    const label = c.sourceType ?? "source";
    return `[${i + 1}] (${label}) ${c.excerpt}`;
  });
  return {
    answer: `Based on indexed evidence for “${input.query}”:\n\n${lines.join("\n\n")}`,
    citationKeys: input.evidence.map((c) => c.sourceKey),
  };
}
