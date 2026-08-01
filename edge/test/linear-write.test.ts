import { describe, expect, it, vi } from "vitest";
import {
  assertLinearWriteApprovalCurrent,
  createLinearIssue,
  createLinearWriteApproval,
  digestLinearIssueDraft,
  linearWriteApprovalKey,
  normalizeLinearIssueDraft,
} from "../src/connectors/linear-write.js";
import { issueConnectorAuthorization } from "../src/connectors/authorization.js";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const CREDENTIAL = {
  schemaVersion: 1 as const,
  ref: "credential:linear:workspace",
  provider: "linear",
  name: "workspace",
  version: 4,
  status: "active" as const,
  scopes: ["issues:create"],
  subject: "oauth-app",
  issuedAt: "2026-08-01T11:00:00.000Z",
};
const BUNDLE = {
  id: "linear-writes",
  tools: ["save_linear_issue"],
  mcpEndpoints: [],
  secretRefs: [],
  connectorGrants: [{
    connectorId: "linear",
    actions: ["create_issue"],
    scope: "workspace" as const,
    credentialRef: CREDENTIAL.ref,
  }],
  schemaVersion: 1 as const,
  revision: 7,
  status: "active" as const,
};

async function labels() {
  return (await issueConnectorAuthorization({
    bundle: BUNDLE,
    credential: CREDENTIAL,
    identity: {
      workspaceId: "T1",
      projectId: "workspace",
      channelId: "C1",
      requesterId: "U1",
      actorKind: "human",
      executionId: "exec-1",
      threadKey: "slack:C1:1.0",
    },
    connectorId: "linear",
    action: "create_issue",
    now: NOW,
  })).labels;
}

describe("Linear guarded write contract", () => {
  it("normalizes fields and binds a stable digest", async () => {
    const first = normalizeLinearIssueDraft({
      title: "  Incident  ",
      description: "Details",
      assigneeEmail: "USER@EXAMPLE.COM",
      team: "Team",
      project: "Project",
      milestone: "Beta",
    });
    const second = normalizeLinearIssueDraft({
      milestone: "Beta",
      project: "Project",
      team: "Team",
      assigneeEmail: "user@example.com",
      description: "Details",
      title: "Incident",
    });
    expect(first).toEqual(second);
    await expect(digestLinearIssueDraft(first)).resolves.toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(linearWriteApprovalKey("12345678-1234-4234-8234-123456789012")).toBe(
      "linear-write-approval:12345678-1234-4234-8234-123456789012",
    );
  });

  it("requires the exact human approval context and fields", async () => {
    const approval = await createLinearWriteApproval({
      approvalId: "12345678-1234-4234-8234-123456789012",
      teamId: "T1",
      channelId: "C1",
      requesterId: "U1",
      executionId: "exec-1",
      threadKey: "slack:C1:1.0",
      draft: { title: "Incident", team: "Team", project: "Project", milestone: "Beta" },
      now: NOW,
    });
    await expect(assertLinearWriteApprovalCurrent(approval, {
      approvalId: approval.approvalId,
      teamId: "T1",
      channelId: "C1",
      requesterId: "U1",
      executionId: "exec-1",
      threadKey: "slack:C1:1.0",
      draft: { title: "Incident", team: "Team", project: "Project", milestone: "Beta" },
      now: NOW,
    })).resolves.toMatchObject({ action: "create_issue", actorKind: "human" });
    await expect(assertLinearWriteApprovalCurrent(approval, {
      approvalId: approval.approvalId,
      teamId: "T1",
      channelId: "C1",
      requesterId: "U2",
      executionId: "exec-1",
      threadKey: "slack:C1:1.0",
      draft: approval.draft,
      now: NOW,
    })).rejects.toThrow("linear_approval_context_mismatch");
    await expect(assertLinearWriteApprovalCurrent(approval, {
      approvalId: approval.approvalId,
      teamId: "T1",
      channelId: "C1",
      requesterId: "U1",
      executionId: "exec-1",
      threadKey: "slack:C1:1.0",
      draft: { title: "Different", team: "Team" },
      now: NOW,
    })).rejects.toThrow("linear_approval_draft_mismatch");
  });

  it("creates an issue with resolved connector references and revalidates", async () => {
    const tokenRequests: Request[] = [];
    const broker = {
      fetch: vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        tokenRequests.push(new Request(String(_url), init));
        return Response.json({
          schemaVersion: 1,
          ref: CREDENTIAL.ref,
          version: CREDENTIAL.version,
          accessToken: "transient-token",
        });
      }),
    } as unknown as Fetcher;
    const requests: Request[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(String(_url), init);
      requests.push(request);
      return Response.json({
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "issue-1",
              identifier: "BER-42",
              title: "Incident",
              url: "https://linear.app/berendo/issue/BER-42/incident",
            },
          },
        },
      });
    });
    let revalidated = 0;
    const result = await createLinearIssue({
      labels: await labels(),
      bundle: BUNDLE,
      credential: CREDENTIAL,
      credentialBroker: broker,
      draft: {
        title: "Incident",
        description: "Details",
        team: "11111111-1111-4111-8111-111111111111",
        assigneeEmail: undefined,
        project: "22222222-2222-4222-8222-222222222222",
        milestone: "33333333-3333-4333-8333-333333333333",
      },
      fetchImpl,
      now: NOW,
      revalidate: async () => { revalidated += 1; },
    });
    expect(result).toMatchObject({ identifier: "BER-42", title: "Incident" });
    expect(revalidated).toBe(1);
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]!.headers.get("x-opentag-connector-authorization")).toMatch(/^sha256:/);
    const body = JSON.parse(await requests[0]!.clone().text()) as {
      variables: { input: Record<string, string> };
    };
    expect(body.variables.input).toEqual({
      title: "Incident",
      description: "Details",
      teamId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      projectMilestoneId: "33333333-3333-4333-8333-333333333333",
    });
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer transient-token");
  });

  it("resolves exact team, assignee, project, and milestone names", async () => {
    const broker = {
      fetch: vi.fn(async () => Response.json({
        schemaVersion: 1,
        ref: CREDENTIAL.ref,
        version: CREDENTIAL.version,
        accessToken: "transient-token",
      })),
    } as unknown as Fetcher;
    const requests: Request[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(String(_url), init);
      requests.push(request);
      if (requests.length === 1) {
        return Response.json({
          data: {
            teams: { nodes: [{ id: "team-1", name: "Berendo", key: "BER" }] },
            users: { nodes: [{ id: "user-1", email: "user@example.com", name: "User" }] },
            projects: {
              nodes: [{
                id: "project-1",
                name: "Launch",
                projectMilestones: { nodes: [{ id: "milestone-1", name: "Beta" }] },
              }],
            },
          },
        });
      }
      return Response.json({
        data: {
          issueCreate: {
            success: true,
            issue: { id: "issue-2", identifier: "BER-43", title: "Named refs" },
          },
        },
      });
    });
    const result = await createLinearIssue({
      labels: await labels(),
      bundle: BUNDLE,
      credential: CREDENTIAL,
      credentialBroker: broker,
      draft: {
        title: "Named refs",
        team: "Berendo",
        assigneeEmail: "user@example.com",
        project: "Launch",
        milestone: "Beta",
      },
      fetchImpl,
      now: NOW,
    });
    expect(result.identifier).toBe("BER-43");
    expect(requests).toHaveLength(2);
    const mutation = JSON.parse(await requests[1]!.clone().text()) as {
      variables: { input: Record<string, string> };
    };
    expect(mutation.variables.input).toMatchObject({
      teamId: "team-1",
      assigneeId: "user-1",
      projectId: "project-1",
      projectMilestoneId: "milestone-1",
    });
  });

  it("fails closed when the credential lacks issue-create scope", async () => {
    await expect(createLinearIssue({
      labels: await labels(),
      bundle: BUNDLE,
      credential: { ...CREDENTIAL, scopes: ["read"] },
      draft: { title: "Incident", team: "Team" },
      credentialBroker: {} as Fetcher,
    })).rejects.toThrow("linear_issue_create_scope_missing");
  });
});
