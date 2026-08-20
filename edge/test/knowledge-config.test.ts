import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_RUNTIME,
  bundleIdFromReaderPolicyRef,
  disabledTrackedKnowledgeSource,
  isTrackedKnowledgeSourceEnabled,
  parseKnowledgeSourceScope,
  parsePutTrackedKnowledgeSource,
  readerPolicyRefForBundle,
} from "../src/config/knowledge-config.js";
import {
  createKnowledgeJob,
  isIndexedDocumentStatus,
  rejectCallerControlledAddressing,
  slackSourceKey,
  slackKnowledgeMetadataAsFlat,
  validateFlatMetadata,
  workspaceTag,
} from "../src/memory/knowledge-contract.js";

describe("knowledge configuration foundation", () => {
  const scope = { teamId: "T1", projectId: "P1", channelId: "C1" };

  it("fails closed for a missing source and requires an explicit reader policy to enable", () => {
    const missing = disabledTrackedKnowledgeSource(scope);
    expect(missing).toMatchObject({ ...scope, enabled: false, configVersion: 0 });
    expect(isTrackedKnowledgeSourceEnabled(missing)).toBe(false);
    expect(() => parsePutTrackedKnowledgeSource({ ...scope, enabled: true, readerPolicyRef: "" }))
      .toThrow("readerPolicyRef");
    expect(parsePutTrackedKnowledgeSource({
      ...scope,
      enabled: false,
      readerPolicyRef: "",
    })).toMatchObject({ enabled: false, retentionDays: null });
    expect(readerPolicyRefForBundle("project-readers")).toBe("bundle:project-readers");
    expect(bundleIdFromReaderPolicyRef("bundle:project-readers")).toBe("project-readers");
    for (const readerPolicyRef of [
      "project-readers",
      "policy:project-readers",
      "bundle:",
      "bundle:project readers",
      "bundle:project:readers",
    ]) {
      expect(() => parsePutTrackedKnowledgeSource({
        ...scope,
        enabled: true,
        readerPolicyRef,
      })).toThrow("readerPolicyRef");
    }
  });

  it("canonicalizes sourceType to slack and accepts non-slack sourceType", () => {
    expect(parseKnowledgeSourceScope(scope)).toEqual({ ...scope, sourceType: "slack" });
    expect(parseKnowledgeSourceScope(scope).sourceType).toBe("slack");
    expect(parsePutTrackedKnowledgeSource({
      ...scope,
      enabled: false,
      readerPolicyRef: "",
    }).sourceType).toBe("slack");
    expect(parsePutTrackedKnowledgeSource({
      ...scope,
      sourceType: "wiki",
      enabled: false,
      readerPolicyRef: "",
    })).toMatchObject({
      ...scope,
      sourceType: "wiki",
      enabled: false,
    });
    expect(parseKnowledgeSourceScope({
      teamId: "T1",
      projectId: "P1",
      channelId: "scope-docs",
      sourceType: "code",
    })).toEqual({
      teamId: "T1",
      projectId: "P1",
      channelId: "scope-docs",
      sourceType: "code",
    });
    expect(() => parseKnowledgeSourceScope({
      ...scope,
      sourceType: "notion",
    })).toThrow("sourceType");
  });

  it("pins the complete Local runtime tuple without a database URL", () => {
    expect(KNOWLEDGE_RUNTIME).toEqual({
      dataDir: "/var/lib/supermemory",
      openAiModel: "gpt-5.1",
      openAiFastModel: "gpt-5.1",
      openAiTextModel: "gpt-5.1",
      embeddingProvider: "local",
      embeddingModel: "Xenova/bge-base-en-v1.5",
      embeddingDimensions: 768,
    });
  });

  it("derives the one exact workspace tag and stable Slack custom ID", () => {
    expect(workspaceTag("T1")).toBe("workspace:T1");
    expect(slackSourceKey("T1", "C1", "171234.000100")).toBe("slack:T1:C1:171234_000100");
    const job = createKnowledgeJob({
      ...scope,
      threadTs: "171234.000100",
      configVersion: 1,
      requestedAt: "2026-07-19T00:00:00.000Z",
      reason: "event",
    });
    expect(job.sourceKey).toBe("slack:T1:C1:171234_000100");
    expect(() => workspaceTag("T1:prefix")).toThrow("safe identifier");
    expect(() => rejectCallerControlledAddressing({ containerTag: "workspace:T2" }))
      .toThrow("containerTag");
    expect(() => rejectCallerControlledAddressing({ containerTags: ["workspace:T1"] }))
      .toThrow("containerTags");
    expect(() => rejectCallerControlledAddressing({ customId: "other" })).toThrow("customId");
    expect(() => createKnowledgeJob({
      ...scope,
      threadTs: "171234.000100",
      configVersion: 1,
      requestedAt: "not-a-timestamp",
      reason: "event",
    })).toThrow("canonical ISO timestamp");
    expect(createKnowledgeJob({
      ...scope,
      threadTs: "171234.000100",
      observedMessageTs: "171234.000200",
      configVersion: 1,
      requestedAt: "2026-07-19T00:00:00.000Z",
      reason: "event",
    })).toMatchObject({ observedMessageTs: "171234.000200" });
    expect(() => createKnowledgeJob({
      ...scope,
      threadTs: "171234.000100",
      observedMessageTs: "not-a-slack-ts",
      configVersion: 1,
      requestedAt: "2026-07-19T00:00:00.000Z",
      reason: "event",
    })).toThrow("exact Slack timestamp");
    expect(() => createKnowledgeJob({
      ...scope,
      sourceType: "wiki",
      threadTs: "doc-1",
      observedMessageTs: "171234.000200",
      configVersion: 1,
      requestedAt: "2026-07-19T00:00:00.000Z",
      reason: "event",
    })).toThrow("exact Slack timestamp");
  });

  it("allows only flat metadata and treats done as the sole successful terminal status", () => {
    expect(validateFlatMetadata({ projectId: "P1", attempt: 1, active: true }))
      .toEqual({ projectId: "P1", attempt: 1, active: true });
    expect(() => validateFlatMetadata({ nested: { nope: true } })).toThrow("strings, numbers, or booleans");
    expect(() => validateFlatMetadata({ list: ["nope"] })).toThrow("strings, numbers, or booleans");
    expect(slackKnowledgeMetadataAsFlat({
      schemaVersion: 1,
      workspaceId: "T1",
      projectId: "P1",
      channelId: "C1",
      threadTs: "1.0",
      sourceKey: "slack:T1:C1:1_0",
      contentRevision: "sha256:fixture",
      rootTs: "1.0",
      observedAt: "2026-07-19T00:00:00.000Z",
      indexedAt: "2026-07-19T00:00:00.000Z",
      aclPolicyRef: "bundle:readers",
      status: "active",
    })).toMatchObject({ sourceKey: "slack:T1:C1:1_0" });
    for (const status of ["unknown", "queued", "extracting", "chunking", "embedding", "indexing", "failed"] as const) {
      expect(isIndexedDocumentStatus(status)).toBe(false);
    }
    expect(isIndexedDocumentStatus("done")).toBe(true);
  });
});
