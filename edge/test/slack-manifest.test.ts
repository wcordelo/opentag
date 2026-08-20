import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SLACK_REQUIRED_BOT_EVENTS,
  SLACK_REQUIRED_BOT_SCOPES,
} from "../src/slack/installation-contract.js";

const manifest = readFileSync(
  new URL("../../slack-app-manifest.yaml", import.meta.url),
  "utf8",
);

describe("Slack app manifest coverage", () => {
  it("subscribes to message, reaction, membership, and lifecycle event families", () => {
    for (const event of SLACK_REQUIRED_BOT_EVENTS) {
      expect(manifest).toContain(`      - ${event}`);
    }
  });

  it("declares the read and write capabilities required by the lifecycle", () => {
    for (const scope of SLACK_REQUIRED_BOT_SCOPES) {
      expect(manifest).toContain(`      - ${scope}`);
    }
  });
});
