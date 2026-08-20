import { describe, expect, it } from "vitest";
import {
  defaultKnowledgePlanner,
  runWebUiKnowledgeQuery,
  synthesizeFromEvidence,
} from "../src/web-ui/knowledge-query.js";
import {
  enabledProjectSources,
  parseKnowledgeProject,
  projectTag,
  queryTagsForProject,
} from "../src/knowledge/projects.js";
import { whoKnowsFromEvidence } from "../src/memory/retrieval/who-knows.js";
import { enrichSlackThreadForIndex } from "../src/memory/connectors/slack-enrichment.js";

describe("web ui knowledge query", () => {
  it("plans, executes, and synthesizes", async () => {
    const result = await runWebUiKnowledgeQuery({
      query: "wiki restore stalls",
      projectId: "P1",
      availableTools: ["search_wiki", "search_slack"],
      listFactories: {
        search_wiki: async () => [
          {
            id: "wiki:T1:eng:runbook",
            citation: {
              sourceKey: "wiki:T1:eng:runbook",
              sourceType: "wiki",
              projectId: "P1",
              contentRevision: "1",
              excerpt: "Set CKPT_PREFETCH=4",
              aclPolicyRef: "bundle:default",
              retrievedAt: "2026-07-28T00:00:00.000Z",
            },
          },
        ],
      },
      planner: async () => ["search_wiki"],
      synthesizer: async ({ evidence }) => synthesizeFromEvidence({
        query: "wiki restore stalls",
        evidence,
      }),
    });
    expect(result.toolsUsed).toEqual(["search_wiki"]);
    expect(result.evidence).toHaveLength(1);
    expect(result.answer).toContain("CKPT_PREFETCH");
  });

  it("default planner picks code for stack traces", () => {
    expect(
      defaultKnowledgePlanner({
        query: "stack trace in the repo",
        projectId: "P1",
        availableTools: ["search", "search_code", "search_slack"],
      }),
    ).toContain("search_code");
  });
});

describe("projects", () => {
  it("parses projects and query tags", () => {
    const project = parseKnowledgeProject({
      schemaVersion: 1,
      teamId: "T1",
      projectId: "compiler",
      name: "Compiler",
      isolationMode: "tag_fanout",
      sources: [
        { sourceType: "slack", scopeId: "C1", enabled: true },
        { sourceType: "code", scopeId: "monolith", enabled: false },
      ],
      updatedAt: "2026-07-28T00:00:00.000Z",
    });
    expect(enabledProjectSources(project)).toHaveLength(1);
    expect(projectTag("T1", "compiler")).toBe("project:T1:compiler");
    expect(queryTagsForProject({ teamId: "T1", project })).toEqual([
      "workspace:T1",
      "project:T1:compiler",
    ]);
  });
});

describe("who_knows", () => {
  it("aggregates authorship metadata", () => {
    const hits = whoKnowsFromEvidence({
      query: "nfs",
      evidence: [
        { sourceKey: "a", metadata: { rootAuthorId: "U1" } },
        { sourceKey: "b", metadata: { rootAuthorId: "U1" } },
        { sourceKey: "c", metadata: { authorId: "U2" } },
      ],
    });
    expect(hits[0]?.userId).toBe("U1");
    expect(hits[0]?.evidenceCount).toBe(2);
  });
});

describe("slack enrichment", () => {
  it("falls back to transcript without llm", async () => {
    const result = await enrichSlackThreadForIndex({
      transcript: "full thread text",
      threadTopic: "restore",
      messages: [
        { authorId: "U1", text: "x".repeat(250) + " CKPT_PREFETCH rareterm", reactions: 1 },
      ],
      documentFrequencies: new Map([["the", 100], ["ckpt_prefetch", 1], ["rareterm", 1]]),
      corpusSize: 100,
    });
    expect(result.distillStatus).toBe("skipped");
    expect(result.threadEmbedText).toContain("full thread text");
    expect(result.threadEmbedText).toContain("engagement reactions:1");
    expect(result.reactionCount).toBe(1);
    expect(result.burstDocuments.length).toBeGreaterThanOrEqual(0);
  });
});
