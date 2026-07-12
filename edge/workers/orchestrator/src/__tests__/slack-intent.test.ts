import { describe, expect, it } from "vitest";
import {
  buildThreadKey,
  extractResearchObjective,
  isResearchIntent,
} from "../slack-intent";

describe("slack-intent", () => {
  it("detects research intent", () => {
    expect(isResearchIntent("research foo")).toBe(true);
    expect(isResearchIntent("Research: bar")).toBe(true);
    expect(isResearchIntent("please look this up")).toBe(false);
  });

  it("strips mentions and prefix", () => {
    expect(extractResearchObjective("<@U1> research: OpenTag 2.0")).toBe(
      "OpenTag 2.0",
    );
  });

  it("builds thread keys", () => {
    expect(buildThreadKey("slack", "C1", "123.456")).toBe("slack:C1:123.456");
  });
});
