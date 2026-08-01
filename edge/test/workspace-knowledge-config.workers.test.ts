import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { tenantStub } from "../src/tenancy.js";

describe("WorkspaceConfigDO tracked knowledge sources", () => {
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
