import { describe, expect, it } from "vitest";
import {
  getCurrentTeamId,
  runWithTeamId,
  resetRequestContext,
  setCurrentTeamId,
} from "../src/request-context.js";

describe("request-context", () => {
  it("keeps team id across awaited work in one tree", async () => {
    resetRequestContext();
    await runWithTeamId("T-A", async () => {
      expect(getCurrentTeamId()).toBe("T-A");
      await new Promise((r) => setTimeout(r, 5));
      expect(getCurrentTeamId()).toBe("T-A");
    });
    expect(getCurrentTeamId()).toBe("default");
  });

  it("setCurrentTeamId updates the active frame", () => {
    resetRequestContext();
    runWithTeamId("T1", () => {
      setCurrentTeamId("T2");
      expect(getCurrentTeamId()).toBe("T2");
    });
    expect(getCurrentTeamId()).toBe("default");
  });
});
