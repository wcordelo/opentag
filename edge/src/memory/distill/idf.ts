/** Simple token IDF helpers from a document-frequency map. */

const TOKEN_RE = /[a-z0-9_/+.-]+/gi;

/** Lowercase alphanumeric tokens (keeps path-ish refs like `foo/bar.ts`). */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return (text.match(TOKEN_RE) ?? []).map((token) => token.toLowerCase());
}

export type DocFreqMap = ReadonlyMap<string, number> | Readonly<Record<string, number>>;

function docFreq(map: DocFreqMap, token: string): number {
  if (map instanceof Map) return map.get(token) ?? 0;
  return (map as Readonly<Record<string, number>>)[token] ?? 0;
}

/**
 * Classic smoothed IDF: `log((N + 1) / (df + 1)) + 1`.
 * Unknown tokens get the max boost (df = 0).
 */
export function createIdfFn(
  documentFrequency: DocFreqMap,
  totalDocuments: number,
): (token: string) => number {
  if (!Number.isFinite(totalDocuments) || totalDocuments < 1) {
    throw new Error("totalDocuments must be a finite number >= 1");
  }
  const n = totalDocuments;
  return (token: string): number => {
    const df = Math.max(0, docFreq(documentFrequency, token.toLowerCase()));
    return Math.log((n + 1) / (df + 1)) + 1;
  };
}

/** Max IDF among tokens in `text`; 0 when empty. */
export function maxTokenIdf(text: string, corpusIdf: (token: string) => number): number {
  const tokens = tokenize(text);
  if (tokens.length === 0) return 0;
  let max = 0;
  for (const token of tokens) {
    const value = corpusIdf(token);
    if (value > max) max = value;
  }
  return max;
}

/** Sum of unique-token IDFs in `text`. */
export function sumUniqueTokenIdf(text: string, corpusIdf: (token: string) => number): number {
  const seen = new Set<string>();
  let sum = 0;
  for (const token of tokenize(text)) {
    if (seen.has(token)) continue;
    seen.add(token);
    sum += corpusIdf(token);
  }
  return sum;
}
