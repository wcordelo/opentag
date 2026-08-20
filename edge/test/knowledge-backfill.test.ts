import { describe, expect, it, vi } from "vitest";
import {
  createKnowledgeBackfillDryRun,
  discoverAndStoreKnowledgeBackfill,
  executeKnowledgeBackfillPage,
  knowledgeBackfillManifestDigest,
  type KnowledgeBackfillManifest,
} from "../src/memory/knowledge-backfill.js";
import {
  verifyKnowledgeBackfillApproval,
} from "../src/memory/knowledge-backfill-authorization.js";
import {
  signKnowledgeBackfillApproval,
  TEST_KNOWLEDGE_BACKFILL_ISSUER,
  TEST_KNOWLEDGE_BACKFILL_KEY_ID,
  TEST_KNOWLEDGE_BACKFILL_PUBLIC_KEY,
} from "./helpers/knowledge-backfill-approval.js";

const request = {
  manifestId: "manifest-test",
  teamId: "T1",
  projectId: "P1",
  channelIds: ["C1"],
  from: "2026-07-01T00:00:00.000Z",
  to: "2026-07-02T00:00:00.000Z",
  limit: 10,
  maximumRatePerMinute: 5,
  maximumErrors: 1,
  releaseIds: ["worker:release-1", "local:release-2"],
  rollbackOwner: "operator:rollback-owner",
  dryRun: true,
  sourceConfigVersions: { C1: 3 },
};

function oneCandidate(channelId = "C1", threadTs = "1.0") {
  return {
    channelId,
    threadTs,
    observedAt: "2026-07-01T01:00:00.000Z",
  };
}

async function signed(
  manifest: KnowledgeBackfillManifest,
  overrides: Parameters<typeof signKnowledgeBackfillApproval>[2] = {},
) {
  const digest = await knowledgeBackfillManifestDigest(manifest);
  return {
    digest,
    artifact: await signKnowledgeBackfillApproval(
      manifest,
      digest,
      overrides,
    ),
  };
}

const verifier = {
  publicKey: TEST_KNOWLEDGE_BACKFILL_PUBLIC_KEY,
  issuer: TEST_KNOWLEDGE_BACKFILL_ISSUER,
  keyId: TEST_KNOWLEDGE_BACKFILL_KEY_ID,
};

describe("knowledge backfill", () => {
  it("requires exact bounded scope and produces one complete canonical manifest", () => {
    expect(() =>
      createKnowledgeBackfillDryRun({ ...request, channelIds: [] }, [])
    ).toThrow("channel list");
    expect(() =>
      createKnowledgeBackfillDryRun({
        ...request,
        channelIds: ["*"],
      }, [])
    ).toThrow("exact");
    expect(() =>
      createKnowledgeBackfillDryRun({ ...request, dryRun: false }, [])
    ).toThrow("dry-run");
    const result = createKnowledgeBackfillDryRun(request, [
      oneCandidate(),
      oneCandidate(),
      oneCandidate("C2", "2.0"),
    ]);
    expect(result.manifest).toMatchObject({
      schemaVersion: 2,
      manifestId: "manifest-test",
      mode: "dry_run",
      teamId: "T1",
      projectId: "P1",
      channelIds: ["C1"],
      count: 1,
      sourceKeys: ["slack:T1:C1:1_0"],
      discovery: {
        status: "complete",
        channels: [{ channelId: "C1", status: "exhausted" }],
      },
    });
  });

  it("pins every exact source version and makes scope/job tampering evident", async () => {
    const result = createKnowledgeBackfillDryRun({
      ...request,
      channelIds: ["C1", "C2"],
      sourceConfigVersions: { C1: 3, C2: 7 },
    }, [
      oneCandidate(),
      {
        ...oneCandidate("C2", "2.0"),
        observedAt: "2026-07-01T02:00:00.000Z",
      },
    ]);
    expect(result.jobs.map((job) => [job.channelId, job.configVersion]))
      .toEqual([["C1", 3], ["C2", 7]]);
    const digest = await knowledgeBackfillManifestDigest(result.manifest);
    expect(await knowledgeBackfillManifestDigest({
      ...result.manifest,
      channelIds: ["C1"],
    })).not.toBe(digest);
    expect(() =>
      createKnowledgeBackfillDryRun({
        ...request,
        channelIds: ["C1", "C2"],
        sourceConfigVersions: { C1: 3 },
      }, [])
    ).toThrow("one authoritative config version");
  });

  it("has no empty/all-workspace discovery or caller cursor default", async () => {
    const fetchImpl = vi.fn();
    const get = vi.fn();
    const env = {
      SLACK_BOT_TOKEN: "test-token",
      WORKSPACE_CONFIG: { idFromName: vi.fn(), get } as never,
      KNOWLEDGE: { idFromName: vi.fn(), get } as never,
    };
    const base = {
      manifestId: "manifest-scope-validation",
      teamId: "T1",
      projectId: "P1",
      channelIds: [] as string[],
      from: request.from,
      to: request.to,
      maximumCount: 10,
      maximumRatePerMinute: 5,
      maximumErrors: 1,
      releaseIds: request.releaseIds,
      rollbackOwner: request.rollbackOwner,
      fetchImpl,
    };
    await expect(discoverAndStoreKnowledgeBackfill(env, base))
      .rejects.toThrow("non-empty bounded explicit channel list");
    await expect(discoverAndStoreKnowledgeBackfill(env, {
      ...base,
      manifestId: "",
      channelIds: ["C1"],
    })).rejects.toThrow("manifestId");
    await expect(discoverAndStoreKnowledgeBackfill(env, {
      ...base,
      teamId: "*",
      channelIds: ["C1"],
    })).rejects.toThrow("exact");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("verifies external Ed25519 P1 authority and rejects missing key, expiry, and every bound mismatch", async () => {
    const manifest = createKnowledgeBackfillDryRun(
      request,
      [oneCandidate()],
    ).manifest;
    const { digest, artifact } = await signed(manifest);
    await expect(verifyKnowledgeBackfillApproval(
      artifact,
      manifest,
      digest,
      verifier,
    )).resolves.toMatchObject({
      gate: "P1",
      approverKind: "human",
      approverId: "operator:p1-test-approver",
      manifestId: manifest.manifestId,
      maximumCount: 10,
      maximumRatePerMinute: 5,
      maximumErrors: 1,
      releaseIds: request.releaseIds,
      rollbackOwner: request.rollbackOwner,
      artifactDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    await expect(verifyKnowledgeBackfillApproval(
      artifact,
      manifest,
      digest,
      {},
    )).rejects.toThrow("verifier_not_configured");
    const artifactParts = artifact.split(".");
    const signature = artifactParts[2]!;
    const invalidSignature = `${artifactParts[0]}.${artifactParts[1]}.${
      signature.startsWith("A") ? "B" : "A"
    }${signature.slice(1)}`;
    await expect(verifyKnowledgeBackfillApproval(
      invalidSignature,
      manifest,
      digest,
      verifier,
    )).rejects.toThrow("signature_invalid");
    const expired = await signed(manifest, {
      issuedAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-07-01T00:01:00.000Z",
    });
    await expect(verifyKnowledgeBackfillApproval(
      expired.artifact,
      manifest,
      digest,
      verifier,
      Date.parse("2026-07-01T00:02:00.000Z"),
    )).rejects.toThrow("expired");
    const stricter = await signed(manifest, {
      maximumCount: 9,
      maximumRatePerMinute: 4,
      maximumErrors: 0,
    });
    await expect(verifyKnowledgeBackfillApproval(
      stricter.artifact,
      manifest,
      digest,
      verifier,
    )).resolves.toMatchObject({
      maximumCount: 9,
      maximumRatePerMinute: 4,
      maximumErrors: 0,
    });
    for (const overrides of [
      { teamId: "T2" },
      { projectId: "P2" },
      { channelIds: ["C2"] },
      { from: "2026-07-01T00:00:01.000Z" },
      { to: "2026-07-02T00:00:01.000Z" },
      { maximumCount: 11 },
      { maximumRatePerMinute: 6 },
      { maximumErrors: 2 },
      { releaseIds: ["worker:other"] },
      { rollbackOwner: "operator:other" },
      { manifestDigest: `sha256:${"0".repeat(64)}` },
    ]) {
      const mismatched = await signed(manifest, overrides);
      await expect(verifyKnowledgeBackfillApproval(
        mismatched.artifact,
        manifest,
        digest,
        verifier,
      )).rejects.toThrow("scope_budget_or_release_mismatch");
    }
  });

  it("persists partial page acceptance and resumes without re-enqueueing classified jobs", async () => {
    const manifest = createKnowledgeBackfillDryRun({
      ...request,
      channelIds: ["C1", "C2"],
      sourceConfigVersions: { C1: 3, C2: 3 },
    }, [
      oneCandidate(),
      {
        ...oneCandidate("C2", "2.0"),
        observedAt: "2026-07-01T02:00:00.000Z",
      },
    ]).manifest;
    const manifestDigest = await knowledgeBackfillManifestDigest(manifest);
    let results: Record<string, "accepted"> = {};
    let secondAttempt = false;
    const enqueueChannels: string[] = [];
    const descriptorKey = (job: KnowledgeBackfillManifest["jobs"][number]) =>
      `${job.sourceType}|${job.sourceKey}|${job.configVersion}|${job.requestedAt}|${job.reason}`;
    const knowledgeFetch = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
      if (path === "/backfill/get") {
        return Response.json({
          manifest: {
            manifestDigest,
            manifest,
            status: "approved",
            nextJobIndex: 0,
            executionErrorCount: 0,
          },
        });
      }
      if (path === "/backfill/claim") {
        return Response.json({
          manifestDigest,
          manifest,
          status: "running",
          nextJobIndex: 0,
          pendingPageToken: "page-1",
          pendingJobs: manifest.jobs,
          pendingResults: results,
          executionErrorCount: secondAttempt ? 1 : 0,
        });
      }
      if (path === "/backfill/enqueue") {
        enqueueChannels.push(body.job.channelId);
        if (body.job.channelId === "C2" && !secondAttempt) {
          return Response.json({
            accepted: false,
            reason: "out_of_order",
            descriptorKey: descriptorKey(body.job),
          });
        }
        return Response.json({
          accepted: true,
          reason: "new",
          descriptorKey: descriptorKey(body.job),
        });
      }
      if (path === "/state") {
        secondAttempt = true;
        return Response.json({ ledger: null, outbox: null });
      }
      if (path === "/backfill/result") {
        results = { ...results, [body.descriptorKey]: body.disposition };
        return Response.json({
          manifestDigest,
          manifest,
          status: "running",
          nextJobIndex: 0,
          pendingPageToken: "page-1",
          pendingJobs: manifest.jobs,
          pendingResults: results,
          executionErrorCount: 1,
        });
      }
      if (path === "/backfill/fail") {
        return Response.json({
          manifestDigest,
          manifest,
          status: "running",
          nextJobIndex: 0,
          pendingPageToken: "page-1",
          pendingJobs: manifest.jobs,
          pendingResults: results,
          executionErrorCount: 1,
        });
      }
      if (path === "/backfill/commit") {
        return Response.json({
          manifestDigest,
          manifest,
          status: "complete",
          nextJobIndex: 2,
          executionErrorCount: 1,
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    });
    const workspaceFetch = vi.fn(async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        channelId: string;
      };
      return Response.json({
        source: {
          schemaVersion: 1,
          teamId: "T1",
          projectId: "P1",
          channelId: body.channelId,
          enabled: true,
          everEnabled: true,
          readerPolicyRef: "bundle:readers",
          retentionDays: null,
          configVersion: 3,
          updatedAt: "2026-07-02T00:00:00.000Z",
        },
        reason: "explicit_enabled",
      });
    });
    const namespace = (fetcher: typeof knowledgeFetch) => ({
      idFromName: (name: string) => name,
      get: () => ({ fetch: fetcher }),
    });
    const env = {
      KNOWLEDGE: namespace(knowledgeFetch),
      WORKSPACE_CONFIG: namespace(workspaceFetch),
    } as never;
    const partial = await executeKnowledgeBackfillPage(env, {
      teamId: "T1",
      manifestId: manifest.manifestId,
      manifestDigest,
    });
    expect(partial).toMatchObject({
      pageStatus: "partial",
      nextJobIndex: 0,
      enqueued: 1,
      processed: 1,
      pending: 1,
      executionErrorCount: 1,
    });
    const complete = await executeKnowledgeBackfillPage(env, {
      teamId: "T1",
      manifestId: manifest.manifestId,
      manifestDigest,
    });
    expect(complete).toMatchObject({
      pageStatus: "committed",
      status: "complete",
      nextJobIndex: 2,
      enqueued: 1,
      processed: 2,
      pending: 0,
    });
    expect(enqueueChannels.filter((channelId) => channelId === "C1"))
      .toHaveLength(1);
  });
});
