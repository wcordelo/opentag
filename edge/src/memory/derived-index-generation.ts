const INDEX_GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * A derived-index generation is a server-owned identity for one isolated
 * provider state store. It is deliberately not a caller/tool field: changing
 * it is what tells the ledger that old provider document IDs cannot be used
 * against the new store.
 */
export function normalizeDerivedIndexGeneration(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const generation = value.trim();
  if (!generation) return undefined;
  if (!INDEX_GENERATION_PATTERN.test(generation) || generation === "legacy") {
    throw new Error("derived index generation is invalid");
  }
  return generation;
}
