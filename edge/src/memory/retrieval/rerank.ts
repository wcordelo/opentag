/** Optional LLM rerank of search candidates. */

export type RerankLlm = (prompt: string) => Promise<Array<{ id: string; score: number }>>;

export function buildRerankPrompt(
  query: string,
  candidates: Array<{ id: string; excerpt: string }>,
): string {
  const numbered = candidates
    .map((candidate, index) => `${index + 1}. id=${candidate.id}\n${candidate.excerpt}`)
    .join("\n\n");
  return [
    "Rerank the following knowledge candidates for the query.",
    "Return a JSON array of {\"id\":\"...\",\"score\":number} objects, highest score first.",
    "Include every candidate id exactly once.",
    "",
    `Query: ${query}`,
    "",
    "Candidates:",
    numbered,
  ].join("\n");
}

/**
 * Rerank candidates with an LLM. On LLM failure, return the original candidates
 * sliced to `topN` (default 10).
 */
export async function llmRerank<T extends { id: string; excerpt: string }>(input: {
  query: string;
  candidates: T[];
  llm: RerankLlm;
  topN?: number;
}): Promise<T[]> {
  const topN = input.topN ?? 10;
  const limit = Math.max(0, Math.min(topN, input.candidates.length));
  if (limit === 0) return [];
  const fallback = input.candidates.slice(0, limit);

  try {
    const ranked = await input.llm(buildRerankPrompt(input.query, input.candidates));
    if (!Array.isArray(ranked)) throw new Error("rerank response must be an array");

    const byId = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
    const seen = new Set<string>();
    const ordered: T[] = [];

    const scored = ranked
      .filter((entry): entry is { id: string; score: number } =>
        !!entry &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        typeof entry.score === "number" &&
        Number.isFinite(entry.score)
      )
      .sort((left, right) => right.score - left.score);

    for (const entry of scored) {
      if (seen.has(entry.id)) continue;
      const candidate = byId.get(entry.id);
      if (!candidate) continue;
      seen.add(entry.id);
      ordered.push(candidate);
    }

    // Preserve any candidates the LLM omitted, in original order.
    for (const candidate of input.candidates) {
      if (seen.has(candidate.id)) continue;
      ordered.push(candidate);
    }

    return ordered.slice(0, limit);
  } catch {
    return fallback;
  }
}
