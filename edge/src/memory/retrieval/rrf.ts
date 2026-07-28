/** Reciprocal Rank Fusion over multiple ranked lists. */

export type RankedItem<T> = {
  id: string;
  item: T;
  /** 1-based rank within its source list. */
  rank: number;
};

export type FusedItem<T> = {
  id: string;
  item: T;
  score: number;
};

const DEFAULT_K = 60;
const DEFAULT_WEIGHT = 1.0;

/**
 * Fuse ranked lists with RRF: `score += weight / (k + rank)`.
 * Dedupes by `id`, keeping the first `item` seen.
 */
export function reciprocalRankFusion<T>(
  lists: RankedItem<T>[][],
  options?: { k?: number; weight?: number },
): Array<FusedItem<T>> {
  const k = options?.k ?? DEFAULT_K;
  const weight = options?.weight ?? DEFAULT_WEIGHT;
  if (!Number.isFinite(k) || k < 0) throw new Error("k must be a non-negative finite number");
  if (!Number.isFinite(weight)) throw new Error("weight must be finite");

  const scores = new Map<string, FusedItem<T>>();
  for (const list of lists) {
    for (const entry of list) {
      if (!entry.id) continue;
      if (!Number.isFinite(entry.rank) || entry.rank < 1) {
        throw new Error("rank must be a 1-based finite number");
      }
      const contribution = weight / (k + entry.rank);
      const existing = scores.get(entry.id);
      if (existing) {
        existing.score += contribution;
      } else {
        scores.set(entry.id, { id: entry.id, item: entry.item, score: contribution });
      }
    }
  }

  return [...scores.values()].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.id.localeCompare(right.id);
  });
}
