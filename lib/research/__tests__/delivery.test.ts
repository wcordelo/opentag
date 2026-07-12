import { describe, it, expect } from "vitest";
import { parseThreadKey } from "../delivery/slack.js";

describe("Slack delivery", () => {
  it("parses thread key", () => {
    const parsed = parseThreadKey("slack:C123ABC:1234567890.123456");
    expect(parsed).toEqual({
      channel: "C123ABC",
      threadTs: "1234567890.123456",
    });
  });

  it("returns null for invalid keys", () => {
    expect(parseThreadKey("invalid")).toBeNull();
  });
});
