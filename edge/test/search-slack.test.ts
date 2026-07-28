import { describe, expect, it, vi } from "vitest";
import type { AccessBundle, WorkspaceChannelConfig } from "../src/config/access-bundle.js";
import type { Env } from "../src/env.js";
import { bindPermissionSnapshot } from "../src/permissions/context.js";
import { buildPermissionSnapshot } from "../src/permissions/snapshot.js";
import { bindRequestContext } from "../src/request-context.js";
import { bindTurnExecutionContext } from "../src/slack/turn-execution-context.js";
import {
  createSearchSlackTool,
  searchSlackKnowledge,
  type SearchSlackAuthorization,
} from "../src/tools/search-slack.js";

function source(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, teamId: "T1", projectId: "P1", channelId: "C1", enabled: true,
    everEnabled: true, readerPolicyRef: "bundle:readers", retentionDays: null, configVersion: 3,
    updatedAt: "2026-07-19T00:00:00.000Z", ...overrides,
  };
}

function access(
  bundleId = "readers",
  tools: string[] = ["search_slack"],
  updatedAt = "2026-07-19T00:00:00.000Z",
): { config: WorkspaceChannelConfig; bundle: AccessBundle } {
  return {
    config: {
      teamId: "T1",
      channelId: "C1",
      systemPrompt: "sys",
      policies: {},
      accessBundleId: bundleId,
      updatedAt,
    },
    bundle: { id: bundleId, tools, mcpEndpoints: [], secretRefs: [] },
  };
}

function authorization(overrides: {
  teamId?: string;
  channelId?: string;
  bundleId?: string;
  actorKind?: "slack_user" | "slack_automation";
  allowedTools?: string[];
} = {}): SearchSlackAuthorization {
  const teamId = overrides.teamId ?? "T1";
  const channelId = overrides.channelId ?? "C1";
  const bundleId = overrides.bundleId ?? "readers";
  const allowedTools = overrides.allowedTools ?? ["search_slack"];
  const actor = overrides.actorKind === "slack_automation"
    ? { kind: "slack_automation" as const, botId: "B1" }
    : { kind: "slack_user" as const, userId: "U1" };
  return {
    permissionSnapshot: buildPermissionSnapshot({
      teamId,
      channelId,
      conversationKey: `${channelId}::1.0`,
      executionId: "ot1e_search",
      actor,
      config: access(bundleId, allowedTools).config,
      bundle: access(bundleId, allowedTools).bundle,
      allToolNames: ["search_slack"],
      allowedTools,
      runtime: { harnessConnected: false },
    }),
    conversationKey: `${channelId}::1.0`,
    executionId: "ot1e_search",
  };
}

function env(options: {
  sourceResponses?: unknown[][];
  accessResponses?: Array<ReturnType<typeof access>>;
  ledger?: Record<string, unknown> | null;
} = {}): Env {
  const sourceResponses = options.sourceResponses ?? [[source()], [source()]];
  const accessResponses = options.accessResponses ?? [access(), access()];
  let sourceLookup = 0;
  let accessLookup = 0;
  return {
    WORKSPACE_CONFIG: {
      idFromName: vi.fn(),
      get: () => ({
        fetch: vi.fn(async (request: RequestInfo | URL) => {
          const path = new URL(String(request)).pathname;
          if (path === "/listTrackedKnowledgeSources") {
            return Response.json(
              sourceResponses[Math.min(sourceLookup++, sourceResponses.length - 1)] ?? [],
            );
          }
          const current = accessResponses[Math.min(accessLookup, accessResponses.length - 1)]!;
          if (path === "/getConfig") return Response.json(current.config);
          if (path === "/getBundle") {
            accessLookup += 1;
            return Response.json(current.bundle);
          }
          return Response.json({ error: "not_found" }, { status: 404 });
        }),
      }),
    },
    KNOWLEDGE: {
      idFromName: vi.fn(),
      get: () => ({ fetch: vi.fn(async () => Response.json({ ledger: options.ledger ?? null })) }),
    },
  } as unknown as Env;
}

const citation = {
  sourceKey: "slack:T1:C1:1.0", projectId: "P1", channelId: "C1", threadTs: "1.0",
  contentRevision: "sha256:one", excerpt: "result", aclPolicyRef: "bundle:readers",
  retrievedAt: "2026-07-19T00:00:00.000Z",
};

describe("search_slack", () => {
  it("does not call Local for an unconfigured channel", async () => {
    const searchSlack = vi.fn();
    expect(await searchSlackKnowledge({
      env: env({ sourceResponses: [[]] }),
      teamId: "T1", channelId: "C1", authorization: authorization(),
      query: "fixture", adapter: { searchSlack },
    })).toEqual({ status: "unauthorized", citations: [], reason: "source_not_enabled" });
    expect(searchSlack).not.toHaveBeenCalled();
  });

  it("degrades structurally when Local configuration is unavailable", async () => {
    expect(await searchSlackKnowledge({
      env: env(), teamId: "T1", channelId: "C1", authorization: authorization(),
      query: "fixture",
    })).toEqual({ status: "knowledge_unavailable", citations: [], retryable: true });
  });

  it("calls Local only for the exact matching turn bundle policy", async () => {
    const searchSlack = vi.fn(async () => [citation]);
    const result = await searchSlackKnowledge({
      env: env({
        ledger: {
          status: "indexed", projectId: "P1", channelId: "C1", configVersion: 3,
          indexedRevision: "sha256:one",
        },
      }),
      teamId: "T1", channelId: "C1", authorization: authorization(),
      query: "fixture", limit: 4, adapter: { searchSlack },
    });
    expect(searchSlack).toHaveBeenCalledWith(expect.objectContaining({
      teamId: "T1", projectId: "P1", channelId: "C1",
      aclPolicyRef: "bundle:readers", query: "fixture", limit: 4,
    }));
    expect(result).toEqual({ status: "ok", citations: [citation] });
  });

  it.each([
    {
      name: "wrong current bundle",
      sourceResponses: [[source()]],
      accessResponses: [access("other")],
    },
    {
      name: "wrong source policy",
      sourceResponses: [[source({ readerPolicyRef: "bundle:other" })]],
      accessResponses: [access()],
    },
    {
      name: "bundle without the tool",
      sourceResponses: [[source()]],
      accessResponses: [access("readers", [])],
    },
  ])("denies $name before Local", async ({ sourceResponses, accessResponses }) => {
    const searchSlack = vi.fn();
    expect(await searchSlackKnowledge({
      env: env({ sourceResponses, accessResponses }),
      teamId: "T1", channelId: "C1", authorization: authorization(),
      query: "fixture", adapter: { searchSlack },
    })).toEqual({ status: "unauthorized", citations: [], reason: "policy_denied" });
    expect(searchSlack).not.toHaveBeenCalled();
  });

  it("suppresses an old indexed revision after source config version changes", async () => {
    const result = await searchSlackKnowledge({
      env: env({
        ledger: {
          status: "indexed", projectId: "P1", channelId: "C1", configVersion: 2,
          indexedRevision: "sha256:one",
        },
      }),
      teamId: "T1", channelId: "C1", authorization: authorization(),
      query: "fixture", adapter: { searchSlack: vi.fn(async () => [citation]) },
    });
    expect(result).toEqual({ status: "ok", citations: [] });
  });

  it("suppresses results if the source policy changes during Local", async () => {
    const result = await searchSlackKnowledge({
      env: env({
        sourceResponses: [
          [source()],
          [source({ configVersion: 4, readerPolicyRef: "bundle:new" })],
        ],
      }),
      teamId: "T1", channelId: "C1", authorization: authorization(),
      query: "fixture", adapter: { searchSlack: vi.fn(async () => [citation]) },
    });
    expect(result).toEqual({ status: "unauthorized", citations: [], reason: "policy_denied" });
  });

  it("suppresses results if the channel bundle changes during Local", async () => {
    const result = await searchSlackKnowledge({
      env: env({ accessResponses: [access(), access("other")] }),
      teamId: "T1", channelId: "C1", authorization: authorization(),
      query: "fixture", adapter: { searchSlack: vi.fn(async () => [citation]) },
    });
    expect(result).toEqual({ status: "unauthorized", citations: [], reason: "policy_denied" });
  });

  it("suppresses results if channel policy config changes during Local", async () => {
    const result = await searchSlackKnowledge({
      env: env({
        accessResponses: [
          access(),
          access("readers", ["search_slack"], "2026-07-19T00:01:00.000Z"),
        ],
      }),
      teamId: "T1", channelId: "C1", authorization: authorization(),
      query: "fixture", adapter: { searchSlack: vi.fn(async () => [citation]) },
    });
    expect(result).toEqual({ status: "unauthorized", citations: [], reason: "policy_denied" });
  });

  it.each([
    { name: "team", authorization: authorization({ teamId: "T2" }) },
    { name: "channel", authorization: authorization({ channelId: "C2" }) },
  ])("denies a permission snapshot with the wrong $name scope", async ({ authorization: denied }) => {
    const searchSlack = vi.fn();
    expect(await searchSlackKnowledge({
      env: env(), teamId: "T1", channelId: "C1", authorization: denied,
      query: "fixture", adapter: { searchSlack },
    })).toEqual({ status: "unauthorized", citations: [], reason: "policy_denied" });
    expect(searchSlack).not.toHaveBeenCalled();
  });

  it("denies automation and never treats search_slack as automation-safe", async () => {
    const searchSlack = vi.fn();
    expect(await searchSlackKnowledge({
      env: env(), teamId: "T1", channelId: "C1",
      authorization: authorization({
        actorKind: "slack_automation",
        allowedTools: ["search_slack"],
      }),
      query: "fixture", adapter: { searchSlack },
    })).toEqual({ status: "unauthorized", citations: [], reason: "policy_denied" });
    expect(searchSlack).not.toHaveBeenCalled();
  });

  it("suppresses a completed search result when exact-turn Stop wins during Local", async () => {
    const authorized = authorization();
    const thread = { conversationKey: authorized.conversationKey };
    bindRequestContext(thread, { teamId: "T1", requesterId: "U1" });
    bindPermissionSnapshot(thread, authorized.permissionSnapshot);
    bindTurnExecutionContext(thread, {
      threadKey: "slack:C1:1.0",
      executionId: authorized.executionId,
    });
    const assertActive = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("active_turn_tool_suppressed"));
    const search = vi.fn(async () => ({ status: "ok" as const, citations: [] }));
    const tool = createSearchSlackTool({
      env: () => env(),
      channel: () => "C1",
      assertActive,
      search,
    });

    await expect(tool.handler(
      { query: "fixture" },
      { thread } as never,
    )).rejects.toThrow("active_turn_tool_suppressed");
    expect(search).toHaveBeenCalledTimes(1);
    expect(assertActive).toHaveBeenCalledTimes(2);
  });
});
