import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { tenantStub } from "../src/tenancy.js";
import {
  SLACK_REQUIRED_BOT_EVENTS,
  SLACK_REQUIRED_BOT_SCOPES,
} from "../src/slack/installation-contract.js";
import { deriveInternalTenantId } from "../src/platform/tenant-id.js";

describe("WorkspaceConfigDO tracked knowledge sources", () => {
  it("persists Slack manifest coverage per installation generation", async () => {
    const teamId = `T${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
    const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);
    const activated = await stub.fetch("https://do/activateSlackInstallation", {
      method: "POST",
      body: JSON.stringify({ teamId, activationId: "oauth-install-1" }),
    });
    expect(await activated.json()).toMatchObject({
      activated: true,
      installation: { generation: 1, status: "active" },
    });
    const readback = {
      schemaVersion: 1,
      teamId,
      botUserId: "UBOT1",
      botScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      botEvents: [...SLACK_REQUIRED_BOT_EVENTS],
      observedAt: "2026-08-02T07:00:00.000Z",
    };

    const first = await stub.fetch("https://do/recordSlackInstallationManifest", {
      method: "POST",
      body: JSON.stringify({ ...readback, installationGeneration: 1 }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as {
      recorded: boolean;
      duplicate: boolean;
      manifest: { generation: number; current: boolean; status: string; manifestDigest: string };
    };
    expect(firstBody).toMatchObject({
      recorded: true,
      duplicate: false,
      manifest: { generation: 1, current: true, status: "complete" },
    });
    expect(firstBody.manifest.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const duplicate = await stub.fetch("https://do/recordSlackInstallationManifest", {
      method: "POST",
      body: JSON.stringify({ ...readback, installationGeneration: 1 }),
    });
    expect(await duplicate.json()).toMatchObject({ recorded: false, duplicate: true });

    expect(await stub.fetch("https://do/getSlackInstallationManifest", {
      method: "POST",
      body: JSON.stringify({ teamId }),
    }).then((response) => response.json())).toMatchObject({
      installation: { generation: 1, status: "active" },
      manifest: { generation: 1, current: true, status: "complete" },
      fresh: true,
    });

    const incomplete = await stub.fetch("https://do/recordSlackInstallationManifest", {
      method: "POST",
      body: JSON.stringify({
        ...readback,
        installationGeneration: 1,
        botScopes: [...SLACK_REQUIRED_BOT_SCOPES].filter((scope) => scope !== "reactions:read"),
        botEvents: [...SLACK_REQUIRED_BOT_EVENTS].filter((event) => event !== "reaction_added"),
        observedAt: "2026-08-02T07:01:00.000Z",
      }),
    });
    expect(await incomplete.json()).toMatchObject({
      recorded: true,
      manifest: {
        generation: 1,
        current: true,
        status: "incomplete",
        missingScopes: ["reactions:read"],
        missingEvents: ["reaction_added"],
      },
    });

    const wrongGeneration = await stub.fetch("https://do/recordSlackInstallationManifest", {
      method: "POST",
      body: JSON.stringify({ ...readback, installationGeneration: 2 }),
    });
    expect(wrongGeneration.status).toBe(409);
    expect(await wrongGeneration.json()).toEqual({ error: "slack_installation_generation_conflict" });

    const stale = await stub.fetch("https://do/recordSlackInstallationManifest", {
      method: "POST",
      body: JSON.stringify({
        ...readback,
        installationGeneration: 1,
        observedAt: "2026-08-02T06:59:00.000Z",
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "slack_installation_manifest_stale" });

    const reactivated = await stub.fetch("https://do/activateSlackInstallation", {
      method: "POST",
      body: JSON.stringify({ teamId, activationId: "oauth-install-2" }),
    });
    expect(await reactivated.json()).toMatchObject({
      activated: true,
      installation: { generation: 2, status: "active" },
    });
    expect(await stub.fetch("https://do/getSlackInstallationManifest", {
      method: "POST",
      body: JSON.stringify({ teamId }),
    }).then((response) => response.json())).toMatchObject({
      installation: { generation: 2, status: "active" },
      manifest: { generation: 1, current: false, status: "incomplete" },
      fresh: false,
    });

    const current = await stub.fetch("https://do/recordSlackInstallationManifest", {
      method: "POST",
      body: JSON.stringify({
        ...readback,
        installationGeneration: 2,
        observedAt: "2026-08-02T07:02:00.000Z",
      }),
    });
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      recorded: true,
      manifest: { generation: 2, current: true, status: "complete" },
    });

    const adminSecret = (env as unknown as { ADMIN_SECRET: string }).ADMIN_SECRET;
    const forwarded = await SELF.fetch("https://worker/admin/slack/installation/manifest", {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        teamId,
        readback: { ...readback, observedAt: "2026-08-02T07:03:00.000Z" },
      }),
    });
    expect(forwarded.status).toBe(200);
    await expect(forwarded.json()).resolves.toMatchObject({
      recorded: true,
      manifest: { generation: 2, current: true, status: "complete" },
    });

    const forwardedLookup = await SELF.fetch("https://worker/admin/slack/installation/manifest/get", {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ teamId }),
    });
    expect(forwardedLookup.status).toBe(200);
    await expect(forwardedLookup.json()).resolves.toMatchObject({
      installation: { generation: 2, status: "active" },
      manifest: { generation: 2, current: true, status: "complete" },
    });
  });

  it("resolves a server-owned all-delivered Slack policy without caller project input", async () => {
    const teamId = `knowledge-admission-${crypto.randomUUID()}`;
    const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);

    expect(await stub.fetch("https://do/getKnowledgeAdmissionPolicy", {
      method: "POST",
      body: JSON.stringify({ teamId }),
    }).then((response) => response.json())).toBeNull();

    const configured = await stub.fetch("https://do/putKnowledgeAdmissionPolicy", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        expectedConfigVersion: 0,
        mode: "all_delivered",
        defaultProjectId: "workspace-default",
        readerPolicyRef: "bundle:readers",
        retentionDays: 30,
      }),
    }).then((response) => response.json()) as {
      mode: string;
      defaultProjectId: string;
      configVersion: number;
    };
    expect(configured).toMatchObject({
      mode: "all_delivered",
      defaultProjectId: "workspace-default",
      configVersion: 1,
    });

    const first = await stub.fetch("https://do/resolveSlackKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C1" }),
    }).then((response) => response.json()) as {
      source: { projectId: string; channelId: string; enabled: boolean; configVersion: number };
      reason: string;
    };
    expect(first).toMatchObject({
      reason: "workspace_default_created",
      source: {
        projectId: "workspace-default",
        channelId: "C1",
        enabled: true,
        configVersion: 1,
      },
    });

    const repeated = await stub.fetch("https://do/resolveSlackKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C1" }),
    }).then((response) => response.json()) as typeof first;
    expect(repeated).toEqual({
      source: first.source,
      reason: "explicit_enabled",
    });

    const automatic = await stub.fetch("https://do/resolveSlackKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C2" }),
    }).then((response) => response.json()) as {
      source: { projectId: string; channelId: string; enabled: boolean; configVersion: number };
      reason: string;
    };
    expect(automatic).toMatchObject({
      reason: "workspace_default_created",
      source: { projectId: "workspace-default", channelId: "C2", enabled: true },
    });

    const effectToken = crypto.randomUUID();
    expect(await stub.fetch("https://do/beginKnowledgeIngestionEffect", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        projectId: "workspace-default",
        channelId: "C2",
        configVersion: automatic.source.configVersion,
        effectToken,
        leaseMs: 80_000,
      }),
    }).then((response) => response.json())).toMatchObject({ decision: "lease" });
    const blockedPolicy = await stub.fetch("https://do/putKnowledgeAdmissionPolicy", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        expectedConfigVersion: 1,
        mode: "explicit",
        defaultProjectId: "workspace-default",
        readerPolicyRef: "",
      }),
    });
    expect(blockedPolicy.status).toBe(409);
    expect(await blockedPolicy.json()).toMatchObject({
      error: "knowledge_admission_policy_active_ingestion_effect",
    });
    await stub.fetch("https://do/releaseKnowledgeIngestionEffect", {
      method: "POST",
      body: JSON.stringify({ effectToken }),
    });

    const disabled = await stub.fetch("https://do/putTrackedKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        projectId: "workspace-default",
        channelId: "C1",
        enabled: false,
        readerPolicyRef: "",
      }),
    });
    expect(disabled.status).toBe(200);
    expect(await stub.fetch("https://do/resolveSlackKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C1" }),
    }).then((response) => response.json())).toMatchObject({
      source: null,
      reason: "source_disabled",
    });

    const conflict = await stub.fetch("https://do/putKnowledgeAdmissionPolicy", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        expectedConfigVersion: 0,
        mode: "explicit",
        defaultProjectId: "workspace-default",
        readerPolicyRef: "",
      }),
    });
    expect(conflict.status).toBe(409);

    const disabledPolicy = await stub.fetch("https://do/putKnowledgeAdmissionPolicy", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        expectedConfigVersion: 1,
        mode: "explicit",
        defaultProjectId: "workspace-default",
        readerPolicyRef: "",
      }),
    }).then((response) => response.json()) as { mode: string; configVersion: number };
    expect(disabledPolicy).toMatchObject({ mode: "explicit", configVersion: 2 });
    expect(await stub.fetch("https://do/getTrackedKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ teamId, projectId: "workspace-default", channelId: "C2" }),
    }).then((response) => response.json())).toMatchObject({
      enabled: false,
      everEnabled: true,
      configVersion: 2,
    });
    expect(await stub.fetch("https://do/resolveSlackKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C2" }),
    }).then((response) => response.json())).toMatchObject({
      source: null,
      reason: "source_disabled",
    });

    const reenabledPolicy = await stub.fetch("https://do/putKnowledgeAdmissionPolicy", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        expectedConfigVersion: 2,
        mode: "all_delivered",
        defaultProjectId: "workspace-default",
        readerPolicyRef: "bundle:readers",
      }),
    }).then((response) => response.json()) as { mode: string; configVersion: number };
    expect(reenabledPolicy).toMatchObject({ mode: "all_delivered", configVersion: 3 });
    expect(await stub.fetch("https://do/resolveSlackKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C2" }),
    }).then((response) => response.json())).toMatchObject({
      source: null,
      reason: "source_disabled",
    });
    expect(await stub.fetch("https://do/resolveSlackKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C3" }),
    }).then((response) => response.json())).toMatchObject({
      reason: "workspace_default_created",
      source: { projectId: "workspace-default", enabled: true },
    });
  });

  it("allows disabled-never-enabled first activation but blocks post-disable re-enable", async () => {
    const teamId = `knowledge-lifecycle-${crypto.randomUUID()}`;
    const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);
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
    const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);
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
    const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);
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
    const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);
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

    const enabledRows = await stub.fetch("https://do/listEnabledTrackedKnowledgeSources", {
      method: "POST",
      body: JSON.stringify({ teamId }),
    }).then((response) => response.json()) as Array<{ channelId: string; projectId: string }>;
    expect(enabledRows).toEqual([
      expect.objectContaining({ channelId: "C1", projectId: "P1" }),
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

    const wiki = await stub.fetch("https://do/putTrackedKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({
        ...scope,
        sourceType: "wiki",
        enabled: true,
        readerPolicyRef: "bundle:wiki-readers",
      }),
    }).then((response) => response.json()) as {
      sourceType: string;
      enabled: boolean;
    };
    expect(wiki).toMatchObject({ sourceType: "wiki", enabled: true });
    expect(await stub.fetch("https://do/getTrackedKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ ...scope, sourceType: "wiki" }),
    }).then((response) => response.json())).toMatchObject({
      sourceType: "wiki",
      enabled: true,
    });
    expect(await stub.fetch("https://do/getTrackedKnowledgeSource", {
      method: "POST",
      body: JSON.stringify(scope),
    }).then((response) => response.json())).toMatchObject({
      sourceType: "slack",
      enabled: false,
    });
    expect(await stub.fetch("https://do/listTrackedKnowledgeSources", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C1" }),
    }).then((response) => response.json())).toEqual([]);
  });
});

describe("WorkspaceConfigDO connector authorization metadata", () => {
  it("versions and permanently revokes connector access bundles", async () => {
    const teamId = `connector-bundle-${crypto.randomUUID()}`;
    const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);
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
    const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);
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
    const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);
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

    const tenantId = await deriveInternalTenantId({
      externalPlatform: "slack",
      externalTenantId: teamId,
    });
    const principalId = "22222222-2222-5222-8222-222222222222";
    const platformBound = await stub.fetch("https://do/issueConnectorAuthorization", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        projectId: "P1",
        channelId: "C1",
        requesterId: principalId,
        principalId,
        actorKind: "human",
        executionId: "exec-platform-1",
        threadKey: "thread-1",
        connectorId: "google_drive",
        action: "search",
        platformBinding: {
          schemaVersion: 1,
          platform: "slack",
          platformTenantId: teamId,
          platformSubjectId: "U1",
          tenantId,
          principalId,
          identityLinkVersion: 2,
          authorizationVersion: 3,
          tenantLocatorVersion: 1,
          oauthGrantVersion: 4,
          marketplaceVersion: "2026-08-01",
        },
      }),
    });
    expect(platformBound.status).toBe(200);
    expect(await platformBound.json()).toMatchObject({
      labels: { platformBinding: { tenantId, principalId, oauthGrantVersion: 4 } },
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

  it("revokes Slack installation generations and disables indexed sources idempotently", async () => {
    const teamId = `slack-lifecycle-${crypto.randomUUID()}`;
    const stub = tenantStub(env.WORKSPACE_CONFIG, teamId);
    const source = await stub.fetch("https://do/putTrackedKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        projectId: "P1",
        channelId: "C1",
        enabled: true,
        readerPolicyRef: "bundle:readers",
      }),
    }).then((response) => response.json()) as { configVersion: number; enabled: boolean };
    expect(source).toMatchObject({ configVersion: 1, enabled: true });

    const revoked = await stub.fetch("https://do/applySlackLifecycle", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        eventId: "EvUninstall",
        eventType: "app_uninstalled",
        observedAt: "2026-08-02T07:00:00.000Z",
      }),
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      applied: true,
      duplicate: false,
      affectedChannels: ["C1"],
    });

    expect(await stub.fetch("https://do/getSlackInstallationState", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C1" }),
    }).then((response) => response.json())).toMatchObject({
      installation: { status: "revoked", generation: 1 },
    });
    expect(await stub.fetch("https://do/resolveSlackKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "C1" }),
    }).then((response) => response.json())).toEqual({
      source: null,
      reason: "installation_revoked",
    });
    expect(await stub.fetch("https://do/getTrackedKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ teamId, projectId: "P1", channelId: "C1" }),
    }).then((response) => response.json())).toMatchObject({
      enabled: false,
      everEnabled: true,
      configVersion: 2,
      readerPolicyRef: "",
    });

    const duplicate = await stub.fetch("https://do/applySlackLifecycle", {
      method: "POST",
      body: JSON.stringify({ teamId, eventId: "EvUninstall", eventType: "app_uninstalled" }),
    });
    expect(await duplicate.json()).toMatchObject({ applied: false, duplicate: true });

    const activated = await stub.fetch("https://do/activateSlackInstallation", {
      method: "POST",
      body: JSON.stringify({ teamId, activationId: "oauth-install-2" }),
    });
    expect(await activated.json()).toMatchObject({
      activated: true,
      installation: { status: "active", generation: 2 },
    });
    expect((await stub.fetch("https://do/putTrackedKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        projectId: "P1",
        channelId: "C1",
        enabled: true,
        readerPolicyRef: "bundle:readers",
      }),
    })).status).toBe(409);

    const privateSource = await stub.fetch("https://do/putTrackedKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        projectId: "P2",
        channelId: "G1",
        enabled: true,
        readerPolicyRef: "bundle:readers",
      }),
    }).then((response) => response.json()) as { enabled: boolean };
    expect(privateSource).toMatchObject({ enabled: true });
    expect(await stub.fetch("https://do/applySlackLifecycle", {
      method: "POST",
      body: JSON.stringify({ teamId, eventId: "EvGroupArchive", eventType: "group_archive", channelId: "G1" }),
    }).then((response) => response.json())).toMatchObject({
      applied: true,
      affectedChannels: ["G1"],
    });
    expect(await stub.fetch("https://do/getSlackInstallationState", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "G1" }),
    }).then((response) => response.json())).toMatchObject({
      channel: { status: "archived", generation: 1 },
    });
    expect(await stub.fetch("https://do/applySlackLifecycle", {
      method: "POST",
      body: JSON.stringify({ teamId, eventId: "EvGroupOpen", eventType: "group_open", channelId: "G1" }),
    }).then((response) => response.json())).toMatchObject({
      applied: true,
      affectedChannels: ["G1"],
    });
    expect(await stub.fetch("https://do/getSlackInstallationState", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "G1" }),
    }).then((response) => response.json())).toMatchObject({
      channel: { status: "active", generation: 2 },
    });
    expect(await stub.fetch("https://do/resolveSlackKnowledgeSource", {
      method: "POST",
      body: JSON.stringify({ teamId, channelId: "G1" }),
    }).then((response) => response.json())).toMatchObject({
      source: null,
      reason: "source_disabled",
    });
  });
});
