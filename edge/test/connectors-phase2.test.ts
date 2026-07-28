import { describe, expect, it } from "vitest";
import { normalizeWikiPage } from "../src/memory/connectors/wiki-connector.js";
import { chunkCodeFile } from "../src/memory/connectors/code-connector.js";
import { normalizeCustomDbRows } from "../src/memory/connectors/custom-db-connector.js";
import { CONNECTOR_REGISTRY } from "../src/memory/knowledge-connector.js";

describe("wiki connector", () => {
  it("normalizes a page and section chunks", () => {
    const docs = normalizeWikiPage({
      teamId: "T1",
      projectId: "P1",
      spaceId: "eng",
      pageId: "runbook",
      title: "Restore",
      body: "## Prefetch\nSet CKPT_PREFETCH=4.\n\n## NFS\nUse the mount guide.",
      updatedAt: "2026-07-28T00:00:00.000Z",
      aclPolicyRef: "bundle:default",
    });
    expect(docs[0]?.sourceKey).toBe("wiki:T1:eng:runbook");
    expect(docs.length).toBeGreaterThan(1);
    expect(docs.some((d) => d.sourceKey.includes("#prefetch"))).toBe(true);
    expect(docs[0]?.metadata.sourceType).toBe("wiki");
  });
});

describe("code connector", () => {
  it("chunks TypeScript by function boundaries", () => {
    const docs = chunkCodeFile({
      teamId: "T1",
      projectId: "P1",
      repoId: "opentag",
      path: "src/foo.ts",
      language: "ts",
      content: "export function a() {\n  return 1;\n}\n\nexport function b() {\n  return 2;\n}\n",
      aclPolicyRef: "bundle:default",
      observedAt: "2026-07-28T00:00:00.000Z",
    });
    expect(docs.length).toBeGreaterThanOrEqual(2);
    expect(docs[0]?.sourceType).toBe("code");
    expect(docs[0]?.sourceKey.startsWith("code:T1:opentag:")).toBe(true);
  });
});

describe("custom db connector", () => {
  it("normalizes emitter rows", () => {
    const docs = normalizeCustomDbRows({
      teamId: "T1",
      projectId: "P1",
      connectorId: "sales_kpi",
      aclPolicyRef: "bundle:default",
      rows: [
        { rowId: "r1", title: "ARR", content: "Annual recurring revenue is $1." },
        { rowId: "r2", content: "   " },
      ],
    });
    expect(docs).toHaveLength(1);
    expect(docs[0]?.sourceKey).toBe("custom_db:T1:sales_kpi:r1");
    expect(docs[0]?.content).toContain("ARR");
  });
});

describe("connector registry", () => {
  it("marks wiki/code/custom_db implemented", () => {
    expect(CONNECTOR_REGISTRY.wiki?.implemented).toBe(true);
    expect(CONNECTOR_REGISTRY.code?.implemented).toBe(true);
    expect(CONNECTOR_REGISTRY.custom_db?.implemented).toBe(true);
  });
});
