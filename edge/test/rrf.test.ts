import { describe, expect, it } from "vitest";
import { reciprocalRankFusion, type RankedItem } from "../src/memory/retrieval/rrf.js";

describe("reciprocal rank fusion", () => {
  it("fuses overlapping ids with default k=60", () => {
    const lists: RankedItem<string>[][] = [
      [
        { id: "a", item: "A1", rank: 1 },
        { id: "b", item: "B1", rank: 2 },
      ],
      [
        { id: "b", item: "B2", rank: 1 },
        { id: "c", item: "C1", rank: 2 },
      ],
    ];
    const fused = reciprocalRankFusion(lists);
    expect(fused.map((entry) => entry.id)).toEqual(["b", "a", "c"]);
    expect(fused[0]?.score).toBeCloseTo(1 / 61 + 1 / 62, 10);
    expect(fused[1]?.score).toBeCloseTo(1 / 61, 10);
    expect(fused[2]?.score).toBeCloseTo(1 / 62, 10);
    // First item seen wins on dedupe.
    expect(fused[0]?.item).toBe("B1");
  });

  it("applies custom k and weight", () => {
    const lists: RankedItem<number>[][] = [
      [{ id: "x", item: 1, rank: 1 }],
    ];
    const fused = reciprocalRankFusion(lists, { k: 10, weight: 2 });
    expect(fused).toEqual([{ id: "x", item: 1, score: 2 / 11 }]);
  });

  it("returns empty for empty lists", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });

  it("rejects non-positive ranks", () => {
    expect(() =>
      reciprocalRankFusion([[{ id: "a", item: "a", rank: 0 }]]),
    ).toThrow(/1-based/);
  });
});
