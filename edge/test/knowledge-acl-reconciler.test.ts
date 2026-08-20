import { afterEach, describe, expect, it, vi } from "vitest";
import {
  reconcileSlackKnowledgeAclForTeam,
  refreshSlackKnowledgeAcl,
  type KnowledgeAclRefreshEnv,
} from "../src/memory/knowledge-acl-reconciler.js";

function namespace(fetch: (request: Request) => Promise<Response>) {
  return {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: (input: string | Request, init?: RequestInit) =>
        fetch(input instanceof Request ? input : new Request(input, init)),
    }),
  };
}

function env(args: {
  workspaceFetch?: (request: Request) => Promise<Response>;
  knowledgeFetch: (request: Request) => Promise<Response>;
}): KnowledgeAclRefreshEnv {
  return {
    WORKSPACE_CONFIG: namespace(args.workspaceFetch ?? (async () => Response.json([]))),
    KNOWLEDGE: namespace(args.knowledgeFetch),
    SLACK_BOT_TOKEN: "xoxb-test",
    ENVIRONMENT: "test",
  } as unknown as KnowledgeAclRefreshEnv;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Slack knowledge ACL reconciliation", () => {
  it("fetches a member set and refreshes the exact revision", async () => {
    const knowledgeBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ok: true,
      members: ["U2", "U1"],
    })));
    const result = await refreshSlackKnowledgeAcl(
      env({
        knowledgeFetch: async (request) => {
          const path = new URL(request.url).pathname;
          if (path === "/acl/state") {
            return Response.json({ status: "stale", revision: 7 });
          }
          if (path === "/acl/refresh") {
            knowledgeBodies.push(await request.json() as Record<string, unknown>);
            return Response.json({
              refreshed: true,
              revision: 7,
              membershipDigest: "sha256:members",
            });
          }
          return Response.json({ error: "not_found" }, { status: 404 });
        },
      }),
      { teamId: "T1", channelId: "C1" },
    );

    expect(result).toMatchObject({
      refreshed: true,
      revision: 7,
      memberCount: 2,
    });
    expect(knowledgeBodies).toEqual([{
      teamId: "T1",
      channelId: "C1",
      memberIds: ["U1", "U2"],
      expectedRevision: 7,
    }]);
  });

  it("continues a team pass after one channel refresh fails", async () => {
    const refreshed: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (body.get("channel") === "C1") {
        return Response.json({ ok: false, error: "not_in_channel" });
      }
      return Response.json({ ok: true, members: ["U1"] });
    }));
    const result = await reconcileSlackKnowledgeAclForTeam(
      env({
        workspaceFetch: async () => Response.json([
          { teamId: "T1", projectId: "P1", channelId: "C1", sourceType: "slack", enabled: true },
          { teamId: "T1", projectId: "P1", channelId: "C2", sourceType: "slack", enabled: true },
        ]),
        knowledgeFetch: async (request) => {
          const path = new URL(request.url).pathname;
          if (path === "/acl/state") return Response.json({ status: "fresh", revision: 2 });
          if (path === "/acl/refresh") {
            refreshed.push((await request.json() as { channelId: string }).channelId);
            return Response.json({ refreshed: true, revision: 2 });
          }
          return Response.json({ error: "not_found" }, { status: 404 });
        },
      }),
      "T1",
    );

    expect(result).toMatchObject({ channels: 2, refreshed: 1, conflicts: 0 });
    expect(result.failed).toEqual([{ channelId: "C1", error: "conversations.members failed: not_in_channel" }]);
    expect(refreshed).toEqual(["C2"]);
  });
});
