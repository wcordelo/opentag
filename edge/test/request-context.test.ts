import { describe, expect, it } from "vitest";
import {
  getCurrentTeamId,
  runWithTeamId,
  resetRequestContext,
  setCurrentTeamId,
} from "../src/request-context.js";

describe("request-context ALS", () => {
  it("isolates team ids across concurrent async trees", async () => {
    resetRequestContext();
    const order: string[] = [];

    await Promise.all([
      runWithTeamId("T-A", async () => {
        order.push(`A-start:${getCurrentTeamId()}`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`A-end:${getCurrentTeamId()}`);
      }),
      runWithTeamId("T-B", async () => {
        order.push(`B-start:${getCurrentTeamId()}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`B-end:${getCurrentTeamId()}`);
      }),
    ]);

    expect(order).toContain("A-start:T-A");
    expect(order).toContain("A-end:T-A");
    expect(order).toContain("B-start:T-B");
    expect(order).toContain("B-end:T-B");
  });

  it("setCurrentTeamId updates ALS store when inside runWithTeamId", () => {
    resetRequestContext();
    runWithTeamId("T1", () => {
      setCurrentTeamId("T2");
      expect(getCurrentTeamId()).toBe("T2");
    });
    expect(getCurrentTeamId()).toBe("default");
  });
});
