import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_SOURCE_GRANT_HEADER,
  parseKnowledgeSourceAdminRequest,
  type KnowledgeSourceAction,
} from "../src/config/knowledge-source-authorization.js";
import {
  signKnowledgeSourceGrant,
} from "./helpers/knowledge-source-grant.js";

const PATHS: Record<KnowledgeSourceAction, string> = {
  inspect: "inspect",
  list_exact: "list",
  stage_disabled: "stage",
  update_disabled: "update-disabled",
  enable_first: "enable-first",
  disable: "disable",
};

async function callLifecycle(
  action: KnowledgeSourceAction,
  body: Record<string, unknown>,
  artifact?: string,
) {
  const request = parseKnowledgeSourceAdminRequest(action, body);
  const grant = artifact ?? await signKnowledgeSourceGrant(request);
  return SELF.fetch(`https://worker/admin/knowledge/sources/${PATHS[action]}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${(env as unknown as { ADMIN_SECRET: string }).ADMIN_SECRET}`,
      [KNOWLEDGE_SOURCE_GRANT_HEADER]: grant,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function scope(teamId: string, projectId = "P1", channelId = "C1") {
  return { teamId, projectId, channelId };
}

function stageBody(teamId: string, projectId = "P1", channelId = "C1") {
  return {
    ...scope(teamId, projectId, channelId),
    expectedConfigVersion: 0,
    readerPolicyRef: `bundle:${projectId}-readers`,
    retentionDays: 30,
  };
}

describe("signed tracked-knowledge source lifecycle routes", () => {
  it("persists one-use actor/grant evidence across stage, update, first-enable, list, and disable", async () => {
    const teamId = `source-route-${crypto.randomUUID()}`;
    const exactScope = scope(teamId);

    const inspectBody = { ...exactScope };
    const inspectGrant = await signKnowledgeSourceGrant(
      parseKnowledgeSourceAdminRequest("inspect", inspectBody),
    );
    const inspected = await callLifecycle("inspect", inspectBody, inspectGrant);
    expect(inspected.status).toBe(200);
    await expect(inspected.json()).resolves.toMatchObject({
      ok: true,
      source: { ...exactScope, enabled: false, configVersion: 0 },
      authorization: {
        actor: { kind: "human", id: "operator:test-user" },
        action: "inspect",
        artifactDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    });
    const inspectReplay = await callLifecycle("inspect", inspectBody, inspectGrant);
    expect(inspectReplay.status).toBe(409);
    await expect(inspectReplay.json()).resolves.toMatchObject({
      error: "knowledge_source_grant_replayed",
    });

    const staged = await callLifecycle("stage_disabled", stageBody(teamId));
    expect(staged.status).toBe(200);
    await expect(staged.json()).resolves.toMatchObject({
      source: {
        ...exactScope,
        enabled: false,
        everEnabled: false,
        configVersion: 1,
      },
      authorization: {
        outcome: "authorized",
        configVersionBefore: 0,
        configVersionAfter: 1,
      },
    });

    const updated = await callLifecycle("update_disabled", {
      ...exactScope,
      expectedConfigVersion: 1,
      readerPolicyRef: "bundle:reviewed-readers",
      retentionDays: 14,
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      source: {
        enabled: false,
        everEnabled: false,
        readerPolicyRef: "bundle:reviewed-readers",
        retentionDays: 14,
        configVersion: 2,
      },
    });

    const enabled = await callLifecycle("enable_first", {
      ...exactScope,
      expectedConfigVersion: 2,
    });
    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toMatchObject({
      source: { enabled: true, everEnabled: true, configVersion: 3 },
      authorization: { action: "enable_first" },
    });

    const list = await callLifecycle("list_exact", exactScope);
    expect(list.status).toBe(200);
    const listed = await list.json() as {
      sources: Array<{ teamId: string; projectId: string; channelId: string }>;
      authorizations: Array<{
        actor: { id: string };
        action: string;
        artifactDigest: string;
      }>;
    };
    expect(listed.sources).toEqual([
      expect.objectContaining(exactScope),
    ]);
    expect(listed.authorizations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actor: { kind: "human", id: "operator:test-user" },
        action: "stage_disabled",
        artifactDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      }),
      expect.objectContaining({ action: "enable_first" }),
    ]));

    const staleDisableBody = { ...exactScope, expectedConfigVersion: 2 };
    const staleGrant = await signKnowledgeSourceGrant(
      parseKnowledgeSourceAdminRequest("disable", staleDisableBody),
    );
    const stale = await callLifecycle("disable", staleDisableBody, staleGrant);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: "stale_grant_config_version",
      authorization: {
        outcome: "stale_grant_config_version",
        configVersionBefore: 3,
        configVersionAfter: 3,
      },
    });
    expect((await callLifecycle("disable", staleDisableBody, staleGrant)).status).toBe(409);

    const disabled = await callLifecycle("disable", {
      ...exactScope,
      expectedConfigVersion: 3,
    });
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toMatchObject({
      source: { enabled: false, everEnabled: true, configVersion: 4 },
    });

    const reenable = await callLifecycle("enable_first", {
      ...exactScope,
      expectedConfigVersion: 4,
    });
    expect(reenable.status).toBe(409);
    await expect(reenable.json()).resolves.toMatchObject({
      error: "first_enable_transition_invalid",
    });
  });

  it("rejects wildcard, cross-scope, wrong-action, content-mismatched, and expired grants", async () => {
    const teamId = `source-denial-${crypto.randomUUID()}`;
    const exactBody = stageBody(teamId);
    const exactRequest = parseKnowledgeSourceAdminRequest("stage_disabled", exactBody);
    const exactGrant = await signKnowledgeSourceGrant(exactRequest);

    for (const changed of [
      { ...exactBody, teamId: `${teamId}-other` },
      { ...exactBody, projectId: "P2" },
      { ...exactBody, channelId: "C2" },
      { ...exactBody, retentionDays: 31 },
    ]) {
      const response = await callLifecycle("stage_disabled", changed, exactGrant);
      expect(response.status).toBe(403);
    }

    const wildcard = await SELF.fetch("https://worker/admin/knowledge/sources/stage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${(env as unknown as { ADMIN_SECRET: string }).ADMIN_SECRET}`,
        [KNOWLEDGE_SOURCE_GRANT_HEADER]: exactGrant,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...exactBody, channelId: "*" }),
    });
    expect(wildcard.status).toBe(400);
    await expect(wildcard.json()).resolves.toMatchObject({
      error: "knowledge_source_scope_is_invalid",
    });

    const wrongAction = await callLifecycle(
      "update_disabled",
      { ...exactBody, expectedConfigVersion: 1 },
      exactGrant,
    );
    expect(wrongAction.status).toBe(403);
    await expect(wrongAction.json()).resolves.toMatchObject({
      error: "knowledge_source_grant_scope_or_action_mismatch",
    });

    const expiredGrant = await signKnowledgeSourceGrant(exactRequest, {
      issuedAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const expired = await callLifecycle("stage_disabled", exactBody, expiredGrant);
    expect(expired.status).toBe(403);
    await expect(expired.json()).resolves.toMatchObject({
      error: "knowledge_source_grant_expired_or_invalid",
    });
  });

  it("consumes and audits conflicting-project and active-effect grants without changing config", async () => {
    const teamId = `source-race-${crypto.randomUUID()}`;
    const primaryScope = scope(teamId, "P1", "C1");
    await callLifecycle("stage_disabled", stageBody(teamId, "P1", "C1"));
    const primaryEnable = await callLifecycle("enable_first", {
      ...primaryScope,
      expectedConfigVersion: 1,
    });
    expect(primaryEnable.status).toBe(200);

    await callLifecycle("stage_disabled", stageBody(teamId, "P2", "C1"));
    const conflict = await callLifecycle("enable_first", {
      ...scope(teamId, "P2", "C1"),
      expectedConfigVersion: 1,
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: "conflicting_project_enabled",
      authorization: { outcome: "conflicting_project_enabled" },
    });

    const stub = env.WORKSPACE_CONFIG.get(env.WORKSPACE_CONFIG.idFromName(teamId));
    const effectToken = crypto.randomUUID();
    const effect = await stub.fetch("https://do/beginKnowledgeIngestionEffect", {
      method: "POST",
      body: JSON.stringify({
        ...primaryScope,
        configVersion: 2,
        effectToken,
        leaseMs: 80_000,
      }),
    });
    expect(effect.status).toBe(200);
    await expect(effect.json()).resolves.toMatchObject({ decision: "lease" });

    const racedDisableBody = { ...primaryScope, expectedConfigVersion: 2 };
    const racedGrant = await signKnowledgeSourceGrant(
      parseKnowledgeSourceAdminRequest("disable", racedDisableBody),
    );
    const raced = await callLifecycle("disable", racedDisableBody, racedGrant);
    expect(raced.status).toBe(409);
    await expect(raced.json()).resolves.toMatchObject({
      error: "active_ingestion_effect",
      source: { enabled: true, configVersion: 2 },
      authorization: { outcome: "active_ingestion_effect" },
    });
    expect((await callLifecycle("disable", racedDisableBody, racedGrant)).status).toBe(409);

    await stub.fetch("https://do/releaseKnowledgeIngestionEffect", {
      method: "POST",
      body: JSON.stringify({ effectToken }),
    });
    expect((await callLifecycle("disable", racedDisableBody)).status).toBe(200);
  });
});
