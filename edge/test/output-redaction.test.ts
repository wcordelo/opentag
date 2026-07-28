import { describe, expect, it } from "vitest";
import { redactJsonValue, redactOutputString, REDACTION_MARKER } from "../workers/sandbox/output-redaction.js";

describe("container output redaction", () => {
  it("redacts common secret patterns from streamed strings", () => {
    expect(redactOutputString("token sk-ant-abcdefghijklmnopqrstuvwxyz")).toContain(
      REDACTION_MARKER,
    );
    expect(redactOutputString("Authorization: Bearer abcdefghijklmnop")).toContain(
      REDACTION_MARKER,
    );
    expect(redactJsonValue({ text: "xoxb-1234567890-abcdefghij" })).toEqual({
      text: REDACTION_MARKER,
    });
  });
});
