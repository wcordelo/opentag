/**
 * Query normalization for knowledge retrieval (lexical + hybrid backends).
 * Splits camelCase/PascalCase identifiers so queries like `KnowledgeCitationBase`
 * also match chunked code and docs that embed those symbols.
 */

const CAMEL_BOUNDARY_RE = /([a-z])([A-Z])|([A-Z]+)([A-Z][a-z])/g;
const LEXICAL_TOKEN_RE = /[a-z0-9_]+/g;

/** Insert spaces at camelCase boundaries for downstream tokenizers / hybrid search. */
export function splitIdentifierBoundaries(text: string): string {
  return text.replace(CAMEL_BOUNDARY_RE, (_match, lower, upper, acronym, word) => {
    if (lower && upper) return `${lower} ${upper}`;
    if (acronym && word) return `${acronym} ${word}`;
    return _match;
  });
}

/**
 * Expand a user query for retrieval: preserve the original text and append
 * boundary-split tokens so hybrid search sees both forms.
 */
export function expandKnowledgeSearchQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return trimmed;
  const expanded = splitIdentifierBoundaries(trimmed);
  if (expanded === trimmed) return trimmed;
  return `${trimmed} ${expanded}`;
}

/** Lowercase lexical tokens with camelCase splitting and underscore parts. */
export function tokenizeForLexicalSearch(text: string): string[] {
  const expanded = splitIdentifierBoundaries(text).toLowerCase();
  const raw = expanded.match(LEXICAL_TOKEN_RE) ?? [];
  const tokens = new Set<string>();
  for (const token of raw) {
    tokens.add(token);
    if (token.includes("_")) {
      for (const part of token.split("_")) {
        if (part) tokens.add(part);
      }
    }
  }
  return [...tokens];
}
