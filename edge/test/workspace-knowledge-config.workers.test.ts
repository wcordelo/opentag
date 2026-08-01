import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("WorkspaceConfigDO tracked knowledge sources", () => {
  it("allows disabled-never-enabled first activation but blocks post-disable re-enable", async () => {
    const teamId = `knowledge-lifecycle-${crypto.randomUUID()}`;
    const stub = env.WORKSPACE_CONFIG.get(env.WORKSPACE_CONFIG.idFromName(teamId));
    const scope = { teamId, projectId: "P1", channelId: "C1" };
    const staged = await stub.fetch("https://do/putTrackedKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ ...scope, enabled: false, readerPolicyRef: "" }),
    }).then((response) => response.json()) as {
      enabled: boolean;
      everEnabled: boolean;
      configVersion: number;
    };
    expect(staged).toMatchObject({ enabled: false, everEnabled: false, configVersion: 1 });

    const activated = await stub.fetch("https://do/putTrackedKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ ...scope, enabled: true, readerPolicyRef: "bundle:readers" }),
    }).then((response) => response.json()) as {
      enabled: boolean;
      everEnabled: boolean;
      configVersion: number;
    };
    expect(activated).toMatchObject({ enabled: true, everEnabled: true, configVersion: 2 });

    await stub.fetch("https://do/putTrackedKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ ...scope, enabled: false, readerPolicyRef: "" }),
    });
    expect((await stub.fetch("https://do/putTrackedKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ ...scope, enabled: true, readerPolicyRef: "bundle:readers" }),
    })).status).toBe(409);
  });

  it("serializes concurrent first enables and preserves one project per channel", async () => {
    const teamId = `knowledge-conflict-${crypto.randomUUID()}`;
    const stub = env.WORKSPACE_CONFIG.get(env.WORKSPACE_CONFIG.idFromName(teamId));
    const responses = await Promise.all(["P1", "P2"].map((projectId) =>
      stub.fetch("https://do/putTrackedKnowledgeSource", {
        method: "POST",
        body: JSON.stringify({
          teamId,
          projectId,
          channelId: "C1",
          enabled: true,
          readerPolicyRef: `bundle:${projectId}`,
        }),
      }),
    ));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  });

  it("rejects disable and policy changes while a durable ingestion effect is active", async () => {
    const teamId = `knowledge-effect-${crypto.randomUUID()}`;
    const stub = env.WORKSPACE_CONFIG.get(env.WORKSPACE_CONFIG.idFromName(teamId));
    const scope = { teamId, projectId: "P1", channelId: "C1" };
    const enabled = await stub.fetch("https://do/putTrackedKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ ...scope, enabled: true, readerPolicyRef: "bundle:readers" }),
    }).then((response) => response.json()) as { configVersion: number };
    const effectToken = crypto.randomUUID();
    const effect = await stub.fetch("https://do/beginKnowledgeIngestionEffect", {
      method: "POST",
      body: JSON.stringify({
        ...scope,
        configVersion: enabled.configVersion,
        effectToken,
        leaseMs: 80_000,
      }),
    }).then((response) => response.json()) as { decision: string };
    expect(effect).toMatchObject({ decision: "lease" });

    for (const update of [
      { enabled: false, readerPolicyRef: "" },
      { enabled: true, readerPolicyRef: "bundle:new-policy" },
    ]) {
      const response = await stub.fetch("https://do/putTrackedKnowledgeSource", {
        method: "POST",
        body: JSON.stringify({ ...scope, ...update }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining("active ingestion effect"),
      });
    }
    const validation = await stub.fetch("https://do/validateKnowledgeIngestionEffect", {
      method: "POST",
      body: JSON.stringify({
        ...scope,
        configVersion: enabled.configVersion,
        effectToken,
      }),
    }).then((response) => response.json()) as { valid: boolean };
    expect(validation.valid).toBe(true);
    await stub.fetch("https://do/releaseKnowledgeIngestionEffect", {
      method: "POST",
      body: JSON.stringify({ effectToken }),
    });
    expect((await stub.fetch("https://do/putTrackedKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ ...scope, enabled: false, readerPolicyRef: "" }),
    })).status).toBe(200);
  });

  it("does not inherit channel defaults and owns a monotonic exact-scope version", async () => {
    const teamId = `knowledge-${crypto.randomUUID()}`;
    const stub = env.WORKSPACE_CONFIG.get(env.WORKSPACE_CONFIG.idFromName(teamId));
    const scope = { teamId, projectId: "P1", channelId: "C1" };

    const missing = await stub.fetch("https://do/getTrackedKnowledgeSource", {
      method: "POST", body: JSON.stringify(scope),
    }).then((response) => response.json()) as { enabled: boolean; configVersion: number };
    expect(missing).toMatchObject({ enabled: false, configVersion: 0 });

    const first = await stub.fetch("https://do/putTrackedKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ ...scope, enabled: true, readerPolicyRef: "bundle:readers" }),
    }).then((response) => response.json()) as { enabled: boolean; configVersion: number };
    expect(first).toMatchObject({ enabled: true, configVersion: 1 });

    const exactChannelRows = await stub.fetch("https://do/listTrackedKnowledgeSources", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C1" }),
    }).then((response) => response.json()) as Array<{ projectId: string; enabled: boolean }>;
    expect(exactChannelRows).toEqual([
      expect.objectContaining({ projectId: "P1", enabled: true }),
    ]);

    const conflictingProject = await stub.fetch("https://do/putTrackedKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({
        ...scope,
        projectId: "P2",
        enabled: true,
        readerPolicyRef: "bundle:other-readers",
      }),
    });
    expect(conflictingProject.status).toBe(409);
    expect(await conflictingProject.json()).toMatchObject({
      error: expect.stringContaining("different enabled project"),
    });

    const second = await stub.fetch("https://do/putTrackedKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ ...scope, enabled: false, readerPolicyRef: "" }),
    }).then((response) => response.json()) as { enabled: boolean; configVersion: number };
    expect(second).toMatchObject({ enabled: false, configVersion: 2 });

    const disabledRows = await stub.fetch("https://do/listTrackedKnowledgeSources", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C1" }),
    }).then((response) => response.json()) as unknown[];
    expect(disabledRows).toEqual([]);

    const reenable = await stub.fetch("https://do/putTrackedKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ ...scope, enabled: true, readerPolicyRef: "bundle:readers" }),
    });
    expect(reenable.status).toBe(409);
    expect(await reenable.json()).toMatchObject({
      error: expect.stringContaining("verified deletion/reindex contract"),
    });

    const otherProject = await stub.fetch("https://do/getTrackedKnowledgeSource", {
      method: "POST", body: JSON.stringify({ ...scope, projectId: "P2" }),
    }).then((response) => response.json()) as { enabled: boolean; configVersion: number };
    expect(otherProject).toMatchObject({ enabled: false, configVersion: 0 });
  });
});

describe("WorkspaceConfigDO connector authorization metadata", () => {
  it("versions and permanently revokes connector access bundles", async () => {
    const teamId = `connector-bundle-${crypto.randomUUID()}`;
    const stub = env.WORKSPACE_CONFIG.get(env.WORKSPACE_CONFIG.idFromName(teamId));
    const grant = {
      connectorId: "google_drive",
      actions: ["search"],
      scope: "project",
      projectId: "P1",
      credentialRef: "credential:google:workspace-drive",
    };
    const first = await stub.fetch("https://do/putBundle", {
      method: "POST",
      body: JSON.stringify({
        id: "drive-readers",
        tools: ["search"],
        mcpEndpoints: [],
        secretRefs: [],
        connectorGrants: [grant],
      }),
    }).then((response) => response.json()) as { revision: number; status: string };
    expect(first).toMatchObject({ revision: 1, status: "active" });

    const stored = await stub.fetch("https://do/getBundle", {
      method: "POST",
      body: JSON.stringify({ id: "drive-readers" }),
    }).then((response) => response.json()) as {
      revision: number;
      status: string;
      connectorGrants: unknown[];
    };
    expect(stored).toMatchObject({ revision: 1, status: "active", connectorGrants: [grant] });

    const second = await stub.fetch("https://do/putBundle", {
      method: "POST",
      body: JSON.stringify({
        id: "drive-readers",
        tools: ["search"],
        mcpEndpoints: [],
        secretRefs: [],
        connectorGrants: [{ ...grant, actions: ["search", "list"] }],
      }),
    }).then((response) => response.json()) as { revision: number; status: string };
    expect(second).toMatchObject({ revision: 2, status: "active" });

    const revoked = await stub.fetch("https://do/revokeBundle", {
      method: "POST",
      body: JSON.stringify({ id: "drive-readers" }),
    }).then((response) => response.json()) as { revision: number; status: string };
    expect(revoked).toMatchObject({ revision: 3, status: "revoked" });

    const refused = await stub.fetch("https://do/putBundle", {
      method: "POST",
      body: JSON.stringify({
        id: "drive-readers",
        tools: ["search"],
        mcpEndpoints: [],
        secretRefs: [],
        connectorGrants: [grant],
      }),
    });
    expect(refused.status).toBe(409);
  });

  it("stores only credential-reference metadata and closes revocation", async () => {
    const teamId = `connector-credential-${crypto.randomUUID()}`;
    const stub = env.WORKSPACE_CONFIG.get(env.WORKSPACE_CONFIG.idFromName(teamId));
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const reference = {
      schemaVersion: 1,
      ref: "credential:google:workspace-drive",
      provider: "google",
      name: "workspace-drive",
      version: 1,
      status: "active",
      scopes: ["drive.readonly"],
      subject: `workspace:${teamId}`,
      issuedAt,
      expiresAt,
    };
    const put = await stub.fetch("https://do/putConnectorCredentialReference", {
      method: "POST",
      body: JSON.stringify(reference),
    });
    expect(put.status).toBe(200);
    const stored = await stub.fetch("https://do/getConnectorCredentialReference", {
      method: "POST",
      body: JSON.stringify({ ref: reference.ref }),
    }).then((response) => response.json()) as Record<string, unknown>;
    expect(stored).toMatchObject({ ref: reference.ref, version: 1, status: "active" });
    expect(JSON.stringify(stored)).not.toContain("token");

    const revoked = await stub.fetch("https://do/revokeConnectorCredentialReference", {
      method: "POST",
      body: JSON.stringify({ ref: reference.ref }),
    }).then((response) => response.json()) as { status: string };
    expect(revoked.status).toBe("revoked");
    const refused = await stub.fetch("https://do/putConnectorCredentialReference", {
      method: "POST",
      body: JSON.stringify({ ...reference, version: 2 }),
    });
    expect(refused.status).toBe(409);
  });

  it("issues labels from the DO-owned bundle and credential snapshot", async () => {
    const teamId = `connector-issue-${crypto.randomUUID()}`;
    const stub = env.WORKSPACE_CONFIG.get(env.WORKSPACE_CONFIG.idFromName(teamId));
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const ref = "credential:google:workspace-drive";
    await stub.fetch("https://do/putConnectorCredentialReference", {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        ref,
        provider: "google",
        name: "workspace-drive",
        version: 1,
        status: "active",
        scopes: ["drive.readonly"],
        subject: `workspace:${teamId}`,
        issuedAt,
        expiresAt,
      }),
    });
    await stub.fetch("https://do/putBundle", {
      method: "POST",
      body: JSON.stringify({
        id: "drive-readers",
        tools: ["search"],
        mcpEndpoints: [],
        secretRefs: [],
        connectorGrants: [{
          connectorId: "google_drive",
          actions: ["search"],
          scope: "project",
          projectId: "P1",
          credentialRef: ref,
        }],
      }),
    });
    await stub.fetch("https://do/putAdminConfig", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C1", accessBundleId: "drive-readers" }),
    });

    const issued = await stub.fetch("https://do/issueConnectorAuthorization", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        projectId: "P1",
        channelId: "C1",
        requesterId: "U1",
        actorKind: "human",
        executionId: "exec-1",
        threadKey: "thread-1",
        connectorId: "google_drive",
        action: "search",
      }),
    });
    expect(issued.status).toBe(200);
    expect(await issued.json()).toMatchObject({
      labels: {
        accessBundleId: "drive-readers",
        credentialRef: ref,
        credentialVersion: 1,
      },
    });

    await stub.fetch("https://do/revokeBundle", {
      method: "POST",
      body: JSON.stringify({ id: "drive-readers" }),
    });
    const refused = await stub.fetch("https://do/issueConnectorAuthorization", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        projectId: "P1",
        channelId: "C1",
        requesterId: "U1",
        actorKind: "human",
        executionId: "exec-2",
        threadKey: "thread-1",
        connectorId: "google_drive",
        action: "search",
      }),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "access_bundle_revoked" });
  });
});
