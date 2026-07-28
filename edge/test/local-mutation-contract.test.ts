import { describe, expect, it } from "vitest";
import { isLocalMutationContractVerified } from "../src/memory/local-mutation-contract.js";

describe("isLocalMutationContractVerified", () => {
  it("is false unless SUPERMEMORY_MUTATION_CONTRACT is exactly verified", () => {
    expect(isLocalMutationContractVerified({})).toBe(false);
    expect(isLocalMutationContractVerified({ SUPERMEMORY_MUTATION_CONTRACT: undefined })).toBe(false);
    expect(isLocalMutationContractVerified({ SUPERMEMORY_MUTATION_CONTRACT: "" })).toBe(false);
    expect(isLocalMutationContractVerified({ SUPERMEMORY_MUTATION_CONTRACT: "true" })).toBe(false);
    expect(isLocalMutationContractVerified({ SUPERMEMORY_MUTATION_CONTRACT: "Verified" })).toBe(false);
    expect(isLocalMutationContractVerified({ SUPERMEMORY_MUTATION_CONTRACT: "verified" })).toBe(true);
  });
});
