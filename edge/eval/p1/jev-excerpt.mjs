/**
 * Jev excerpt truncation — keep in sync with edge/src/memory/retrieval/jev-questions.ts.
 */

export const JEV_RERANK_MAX_EXCERPT_CHARS_DEFAULT = 8_000;
export const JEV_RERANK_MAX_EXCERPT_CHARS_CAP = 64_000;
export const JEV_EXCERPT_TRUNCATION_MARKER = "\n[... excerpt truncated for rerank ...]\n";

export function truncateJevExcerpt(excerpt, maxChars) {
  const capped = Math.max(1, Math.min(maxChars, JEV_RERANK_MAX_EXCERPT_CHARS_CAP));
  const trimmed = excerpt.trim();
  if (trimmed.length <= capped) return trimmed;

  const marker = JEV_EXCERPT_TRUNCATION_MARKER;
  const budget = capped - marker.length;
  if (budget <= 0) return trimmed.slice(0, capped);

  const lineBreak = trimmed.lastIndexOf("\n", budget);
  const cut = lineBreak >= Math.floor(budget * 0.5) ? lineBreak : budget;
  return `${trimmed.slice(0, cut)}${marker}`;
}
