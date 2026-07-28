import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

import worker from "../src/worker.js";
import {
  KNOWLEDGE_SOURCE_GRANT_HEADER,
  parseKnowledgeSourceAdminRequest,
} from "../src/config/knowledge-source-authorization.js";
import type { Env } from "../src/env.js";
import {
  TEST_KNOWLEDGE_SOURCE_ISSUER,
  TEST_KNOWLEDGE_SOURCE_KEY_ID,
  TEST_KNOWLEDGE_SOURCE_PUBLIC_KEY,
  signKnowledgeSourceGrant,
} from "./helpers/knowledge-source-grant.js";

function bindings(
  doFetch: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response> =
    async () => Response.json({
      ok: true,
      status: 200,
      source: {
        teamId: "T1",
        projectId: "P1",
        channelId: "C1",
        enabled: false,
        configVersion: 1,
      },
      authorization: { grantId: "persisted" },
    }),
): Env {
  return {
    BOT_STATE: {} as Env["BOT_STATE"],
    WORKSPACE_CONFIG: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: doFetch }),
    } as unknown as Env["WORKSPACE_CONFIG"],
    KNOWLEDGE: {} as Env["KNOWLEDGE"],
    SESSION_EVENTS: {} as Env["SESSION_EVENTS"],
    DELIVERY_METRICS: {} as Env["DELIVERY_METRICS"],
    AGENT_URL: "https://agent",
    ADMIN_SECRET: "admin-secret",
    KNOWLEDGE_SOURCE_AUTH_PUBLIC_KEY: TEST_KNOWLEDGE_SOURCE_PUBLIC_KEY,
    KNOWLEDGE_SOURCE_AUTH_ISSUER: TEST_KNOWLEDGE_SOURCE_ISSUER,
    KNOWLEDGE_SOURCE_AUTH_KEY_ID: TEST_KNOWLEDGE_SOURCE_KEY_ID,
  };
}

function stageBody(projectId = "P1") {
  return {
    teamId: "T1",
    projectId,
    channelId: "C1",
    expectedConfigVersion: 0,
    readerPolicyRef: "bundle:readers",
    retentionDays: 30,
  };
}

describe("tracked knowledge source administration route", () => {
  it("requires both ADMIN_SECRET and an independently signed exact-scope grant", async () => {
    const adminOnly = await worker.fetch(
      new Request("https://worker/admin/knowledge/sources/stage", {
        method: "POST",
        headers: {
          authorization: "Bearer admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify(stageBody()),
      }),
      bindings(),
    );
    expect(adminOnly.status).toBe(403);
    await expect(adminOnly.json()).resolves.toMatchObject({
      error: "knowledge_source_grant_required",
    });

    const signed = await signKnowledgeSourceGrant(
      parseKnowledgeSourceAdminRequest("stage_disabled", stageBody()),
    );
    const noAdmin = await worker.fetch(
      new Request("https://worker/admin/knowledge/sources/stage", {
        method: "POST",
        headers: {
          [KNOWLEDGE_SOURCE_GRANT_HEADER]: signed,
          "content-type": "application/json",
        },
        body: JSON.stringify(stageBody()),
      }),
      bindings(),
    );
    expect(noAdmin.status).toBe(401);
  });

  it("keeps grant issuance disabled when the external verifier gate is unset", async () => {
    const request = parseKnowledgeSourceAdminRequest("stage_disabled", stageBody());
    const signed = await signKnowledgeSourceGrant(request);
    const env = bindings();
    delete env.KNOWLEDGE_SOURCE_AUTH_PUBLIC_KEY;
    const response = await worker.fetch(
      new Request("https://worker/admin/knowledge/sources/stage", {
        method: "POST",
        headers: {
          authorization: "Bearer admin-secret",
          [KNOWLEDGE_SOURCE_GRANT_HEADER]: signed,
          "content-type": "application/json",
        },
        body: JSON.stringify(stageBody()),
      }),
      env,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "knowledge_source_grant_verifier_not_configured",
    });
  });

  it("forwards only verified actor/grant evidence to the exact workspace DO", async () => {
    const doFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(url)).pathname).toBe("/authorizedTrackedKnowledgeSourceAction");
      const body = JSON.parse(String(init?.body)) as {
        request: { action: string; teamId: string; projectId: string; channelId: string };
        grant: { actorId: string; artifactDigest: string };
      };
      expect(body.request).toMatchObject({
        action: "stage_disabled",
        teamId: "T1",
        projectId: "P1",
        channelId: "C1",
      });
      expect(body.grant.actorId).toBe("operator:test-user");
      expect(body.grant.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(String(init?.body)).not.toContain(signed);
      return Response.json({ ok: true, status: 200, authorization: body.grant });
    });
    const request = parseKnowledgeSourceAdminRequest("stage_disabled", stageBody());
    const signed = await signKnowledgeSourceGrant(request);
    const response = await worker.fetch(
      new Request("https://worker/admin/knowledge/sources/stage", {
        method: "POST",
        headers: {
          authorization: "Bearer admin-secret",
          [KNOWLEDGE_SOURCE_GRANT_HEADER]: signed,
          "content-type": "application/json",
        },
        body: JSON.stringify(stageBody()),
      }),
      bindings(doFetch),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(doFetch).toHaveBeenCalledOnce();
  });

  it("rejects cross-project grants before the control-plane DO is called", async () => {
    const doFetch = vi.fn();
    const signedForP1 = await signKnowledgeSourceGrant(
      parseKnowledgeSourceAdminRequest("stage_disabled", stageBody("P1")),
    );
    const response = await worker.fetch(
      new Request("https://worker/admin/knowledge/sources/stage", {
        method: "POST",
        headers: {
          authorization: "Bearer admin-secret",
          [KNOWLEDGE_SOURCE_GRANT_HEADER]: signedForP1,
          "content-type": "application/json",
        },
        body: JSON.stringify(stageBody("P2")),
      }),
      bindings(doFetch),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "knowledge_source_grant_scope_or_action_mismatch",
    });
    expect(doFetch).not.toHaveBeenCalled();
  });
});
