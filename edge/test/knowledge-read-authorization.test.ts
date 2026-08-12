import { describe, expect, it } from "vitest";
import type { AccessBundle, WorkspaceChannelConfig } from "../src/config/access-bundle.js";
import type { Env } from "../src/env.js";
import { buildPermissionSnapshot } from "../src/permissions/snapshot.js";
import {
  currentKnowledgeReadGrantAllows,
  loadCurrentKnowledgeReadAccess,
} from "../src/memory/knowledge-read-authorization.js";

function bundle(revision = 1): AccessBundle {
  return {
    id: "readers",
    tools: ["search_wiki"],
    mcpEndpoints: [],
    secretRefs: [],
    status: "active",
    revision,
    connectorGrants: [{
      connectorId: "wiki",
      actions: ["search_wiki"],
      scope: "project",
      projectId: "P1",
      spaceId: "S1",
    }],
  };
}

function env(current: AccessBundle): Env {
  const config: WorkspaceChannelConfig = {
    teamId: "T1",
    channelId: "C1",
    policies: {},
    accessBundleId: current.id,
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
  return {
    WORKSPACE_CONFIG: {
      idFromName: () => "T1",
      get: () => ({
        fetch: async (input: RequestInfo | URL) => {
          const path = new URL(String(input)).pathname;
          if (path === "/getConfig") return Response.json(config);
          if (path === "/getBundle") return Response.json(current);
          return Response.json({ error: "not_found" }, { status: 404 });
        },
      }),
    } as unknown as Env["WORKSPACE_CONFIG"],
  } as Env;
}

function snapshot(current: AccessBundle) {
  return buildPermissionSnapshot({
    teamId: "T1",
    channelId: "C1",
    conversationKey: "C1::1.0",
    executionId: "exec-1",
    actor: { kind: "slack_user", userId: "U1" },
    config: {
      teamId: "T1",
      channelId: "C1",
      policies: {},
      accessBundleId: current.id,
      updatedAt: "2026-08-02T00:00:00.000Z",
    },
    bundle: current,
    allToolNames: ["search_wiki"],
    allowedTools: ["search_wiki"],
    runtime: { harnessConnected: false },
  });
}

describe("knowledge read authorization", () => {
  it("requires the current exact space grant", async () => {
    const current = bundle();
    const access = await loadCurrentKnowledgeReadAccess(env(current), "T1", "C1");
    expect(currentKnowledgeReadGrantAllows(access, {
      teamId: "T1",
      channelId: "C1",
      projectId: "P1",
      connectorId: "wiki",
      action: "search_wiki",
      spaceId: "S1",
      aclPolicyRef: "bundle:readers",
      permissionSnapshot: snapshot(current),
    })).toBe(true);
    expect(currentKnowledgeReadGrantAllows(access, {
      teamId: "T1",
      channelId: "C1",
      projectId: "P1",
      connectorId: "wiki",
      action: "search_wiki",
      spaceId: "S2",
      aclPolicyRef: "bundle:readers",
      permissionSnapshot: snapshot(current),
    })).toBe(false);
  });

  it("rejects a stale permission snapshot after bundle revision changes", async () => {
    const previous = bundle(1);
    const current = bundle(2);
    const access = await loadCurrentKnowledgeReadAccess(env(current), "T1", "C1");
    expect(currentKnowledgeReadGrantAllows(access, {
      teamId: "T1",
      channelId: "C1",
      projectId: "P1",
      connectorId: "wiki",
      action: "search_wiki",
      spaceId: "S1",
      aclPolicyRef: "bundle:readers",
      permissionSnapshot: snapshot(previous),
    })).toBe(false);
  });
});
