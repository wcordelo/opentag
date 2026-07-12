import { describe, it, expect } from "vitest";
import {
  computeNextAlarmDelay,
  isDeadlinePassed,
  isBudgetExhausted,
  hashFact,
  generateRequestId,
} from "../fiber.js";
import { DEFAULT_TASK_BUDGET } from "../types.js";

describe("fiber helpers", () => {
  it("computes exponential backoff", () => {
    expect(computeNextAlarmDelay(0)).toBe(1000);
    expect(computeNextAlarmDelay(3)).toBe(8000);
  });

  it("detects deadline", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(isDeadlinePassed(past)).toBe(true);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(isDeadlinePassed(future)).toBe(false);
  });

  it("detects budget exhaustion", () => {
    expect(
      isBudgetExhausted(
        { status: "running", objective: "x", fiberIndex: 0, alarmCount: 200 },
        DEFAULT_TASK_BUDGET,
      ),
    ).toBe(true);
  });

  it("hashes facts deterministically", () => {
    expect(hashFact("hello", "http://a.com")).toBe(hashFact("hello", "http://a.com"));
  });

  it("generates unique request ids", () => {
    expect(generateRequestId()).not.toBe(generateRequestId());
  });
});
