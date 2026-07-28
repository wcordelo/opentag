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
    const page = docs[0]!;
    const section = docs.find((d) => d.sourceKey.includes("#prefetch"));
    expect(section).toBeDefined();
    expect(page.revision).toBe(page.metadata.contentRevision);
    expect(section!.revision).toBe(section!.metadata.contentRevision);
    expect(section!.metadata.contentRevision).not.toBe(page.metadata.contentRevision);
  });

  it("updates section contentRevision when only that section changes", () => {
    const base = {
      teamId: "T1",
      projectId: "P1",
      spaceId: "eng",
      pageId: "runbook",
      title: "Restore",
      updatedAt: "2026-07-28T00:00:00.000Z",
      aclPolicyRef: "bundle:default",
    };
    const before = normalizeWikiPage({
      ...base,
      body: "## Prefetch\nSet CKPT_PREFETCH=4.\n\n## NFS\nUse the mount guide.",
    });
    const after = normalizeWikiPage({
      ...base,
      body: "## Prefetch\nSet CKPT_PREFETCH=8.\n\n## NFS\nUse the mount guide.",
    });
    const beforeSection = before.find((d) => d.sourceKey.includes("#prefetch"))!;
    const afterSection = after.find((d) => d.sourceKey.includes("#prefetch"))!;
    const beforeNfs = before.find((d) => d.sourceKey.includes("#nfs"))!;
    const afterNfs = after.find((d) => d.sourceKey.includes("#nfs"))!;
    expect(afterSection.metadata.contentRevision).not.toBe(beforeSection.metadata.contentRevision);
    expect(afterSection.revision).toBe(afterSection.metadata.contentRevision);
    expect(afterNfs.metadata.contentRevision).toBe(beforeNfs.metadata.contentRevision);
  });
});

describe("code connector", () => {
  it("chunks TypeScript by function boundaries and keeps file preamble", () => {
    const docs = chunkCodeFile({
      teamId: "T1",
      projectId: "P1",
      repoId: "opentag",
      path: "src/foo.ts",
      language: "ts",
      content:
        "import { x } from \"./x\";\nconst PREAMBLE = 1;\n\nexport function a() {\n  return 1;\n}\n\nexport function b() {\n  return 2;\n}\n",
      aclPolicyRef: "bundle:default",
      observedAt: "2026-07-28T00:00:00.000Z",
    });
    expect(docs.length).toBeGreaterThanOrEqual(3);
    expect(docs[0]?.content).toContain("import { x }");
    expect(docs[0]?.content).toContain("PREAMBLE");
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

  it("does not let row metadata override canonical tenancy fields", () => {
    const docs = normalizeCustomDbRows({
      teamId: "T1",
      projectId: "P1",
      connectorId: "sales_kpi",
      aclPolicyRef: "bundle:default",
      rows: [{
        rowId: "r1",
        content: "secret row",
        metadata: {
          workspaceId: "OTHER",
          sourceKey: "custom_db:OTHER:evil:r1",
          aclPolicyRef: "bundle:evil",
          status: "deleted",
          projectId: "HACK",
          note: "safe-extra",
        },
      }],
    });
    expect(docs).toHaveLength(1);
    expect(docs[0]?.metadata).toMatchObject({
      workspaceId: "T1",
      projectId: "P1",
      connectorId: "sales_kpi",
      sourceKey: "custom_db:T1:sales_kpi:r1",
      aclPolicyRef: "bundle:default",
      status: "active",
      note: "safe-extra",
    });
  });

  it("rejects caller metadata that fails flat metadata validation", () => {
    expect(() => normalizeCustomDbRows({
      teamId: "T1",
      projectId: "P1",
      connectorId: "sales_kpi",
      aclPolicyRef: "bundle:default",
      rows: [{
        rowId: "r1",
        content: "row",
        metadata: { nested: { nope: true } as unknown as string },
      }],
    })).toThrow("metadata values must be strings, numbers, or booleans");

    expect(() => normalizeCustomDbRows({
      teamId: "T1",
      projectId: "P1",
      connectorId: "sales_kpi",
      aclPolicyRef: "bundle:default",
      rows: [{
        rowId: "r1",
        content: "row",
        metadata: Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [`extra${i}`, `v${i}`]),
        ),
      }],
    })).toThrow("metadata has too many entries");
  });
});

describe("connector registry", () => {
  it("marks wiki/code/custom_db implemented", () => {
    expect(CONNECTOR_REGISTRY.wiki?.implemented).toBe(true);
    expect(CONNECTOR_REGISTRY.code?.implemented).toBe(true);
    expect(CONNECTOR_REGISTRY.custom_db?.implemented).toBe(true);
  });
});
