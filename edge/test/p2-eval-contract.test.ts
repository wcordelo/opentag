import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifySlackResponseRoute } from "../src/slack/response-routing.js";
import { routerJevQuestionDefinitionsArtifact } from "../src/router/jev-route-questions.js";

const evalDir = join(dirname(fileURLToPath(import.meta.url)), "../eval/p2");

type FixtureItem = {
  id: string;
  input: {
    source: "direct_message" | "app_mention" | "trusted_rich_mention" | "thread_reply" | "channel_message";
    message: string;
    hasFiles?: boolean;
  };
};

describe("P2 eval contract", () => {
  it("keeps question-definitions.json aligned with production wording", () => {
    const path = join(evalDir, "question-definitions.json");
    const artifact = routerJevQuestionDefinitionsArtifact();
    if (process.env.REGENERATE_P2_EVAL === "1") {
      writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
    }
    const committed = JSON.parse(readFileSync(path, "utf8"));
    expect(committed).toEqual(artifact);
  });

  it("keeps current-router.json aligned with classifySlackResponseRoute", () => {
    const fixtures = JSON.parse(readFileSync(join(evalDir, "fixtures.json"), "utf8")) as {
      items: FixtureItem[];
    };
    const path = join(evalDir, "current-router.json");
    const computed = fixtures.items.map((item) => {
      const route = classifySlackResponseRoute({
        source: item.input.source,
        userText: item.input.message,
        hasFiles: item.input.hasFiles ?? false,
      });
      return { id: item.id, route: route.decision, reason: route.reason };
    });
    if (process.env.REGENERATE_P2_EVAL === "1") {
      writeFileSync(path, `${JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        items: computed,
      }, null, 2)}\n`);
    }
    const committed = JSON.parse(readFileSync(path, "utf8")) as {
      items: Array<{ id: string; route: string; reason: string }>;
    };
    expect(committed.items).toEqual(computed);
  });
});
