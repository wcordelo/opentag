/** Exact env gate for Local document update/delete. Off unless `verified`. */
export function isLocalMutationContractVerified(env: {
  SUPERMEMORY_MUTATION_CONTRACT?: string;
}): boolean {
  return env.SUPERMEMORY_MUTATION_CONTRACT === "verified";
}
