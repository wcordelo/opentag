import Supermemory from "supermemory";
import { describe, expect, it } from "vitest";
import { slackSourceKey, workspaceTag } from "../src/memory/knowledge-contract.js";
import { createSupermemoryClient } from "../src/memory/supermemory-client.js";

describe("supermemory@4.24.12 SDK contract", () => {
  it("uses the Worker-compatible constructor, add/document surfaces, and exact hybrid search shapes", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const client = new Supermemory({
      apiKey: "sm_fake_contract_key",
      baseURL: "https://local.example",
      timeout: 1_500,
      maxRetries: 0,
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        const path = new URL(String(input)).pathname;
        if (path === "/v3/documents" && init?.method === "POST") {
          return Response.json({ id: "local-doc-1", status: "queued" });
        }
        if (path === "/v3/documents/list" && init?.method === "POST") {
          return Response.json({
            memories: [{
              id: "local-doc-1",
              customId: "slack:T1:C1:1_0",
              metadata: { workspaceId: "T1", sourceKey: "slack:T1:C1:1_0" },
              status: "indexing",
            }],
            pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
          });
        }
        if (path === "/v3/documents/local-doc-1" && init?.method === "GET") {
          return Response.json({ id: "local-doc-1", status: "done", customId: "slack:T1:C1:1_0", metadata: {} });
        }
        if (path === "/v3/documents/local-doc-1" && init?.method === "PATCH") {
          return Response.json({ id: "local-doc-1", status: "queued" });
        }
        if (path === "/v3/documents/local-doc-1" && init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (path === "/v4/search" && init?.method === "POST") {
          return Response.json({ results: [], timing: 1, total: 0 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const tag = workspaceTag("T1");
    const customId = slackSourceKey("T1", "C1", "1.0");
    await client.add({ content: "fixture", containerTag: tag, customId, metadata: { projectId: "P1" } });
    await client.documents.add({ content: "fixture document surface", containerTag: tag, customId, metadata: { projectId: "P1" } });
    await client.documents.get("local-doc-1");
    await client.documents.list({
      containerTags: [tag],
      filters: { AND: [
        { key: "workspaceId", value: "T1" },
        { key: "sourceKey", value: customId },
      ] },
      includeContent: false,
      limit: 10,
      page: 1,
    });
    await client.documents.update("local-doc-1", {
      content: "revised fixture",
      containerTag: tag,
      customId,
      metadata: { projectId: "P1" },
    });
    await client.documents.delete("local-doc-1");
    await client.search.memories({
      q: "fixture",
      containerTag: tag,
      searchMode: "hybrid",
      filters: { AND: [{ key: "projectId", value: "P1" }] },
      limit: 3,
    });
    expect(client.timeout).toBe(1_500);
    expect(client.maxRetries).toBe(0);
    expect(requests).toEqual([
      expect.objectContaining({
        url: "https://local.example/v3/documents",
        method: "POST",
        body: expect.objectContaining({ containerTag: "workspace:T1", customId: "slack:T1:C1:1_0" }),
      }),
      expect.objectContaining({
        url: "https://local.example/v3/documents",
        method: "POST",
        body: expect.objectContaining({ containerTag: "workspace:T1", customId: "slack:T1:C1:1_0" }),
      }),
      expect.objectContaining({ url: "https://local.example/v3/documents/local-doc-1", method: "GET" }),
      expect.objectContaining({
        url: "https://local.example/v3/documents/list",
        method: "POST",
        body: expect.objectContaining({
          containerTags: ["workspace:T1"],
          includeContent: false,
          limit: 10,
          page: 1,
        }),
      }),
      expect.objectContaining({
        url: "https://local.example/v3/documents/local-doc-1",
        method: "PATCH",
        body: expect.objectContaining({
          content: "revised fixture",
          containerTag: "workspace:T1",
          customId: "slack:T1:C1:1_0",
        }),
      }),
      expect.objectContaining({ url: "https://local.example/v3/documents/local-doc-1", method: "DELETE" }),
      expect.objectContaining({
        url: "https://local.example/v4/search",
        method: "POST",
        body: { q: "fixture", containerTag: "workspace:T1", searchMode: "hybrid", filters: { AND: [{ key: "projectId", value: "P1" }] }, limit: 3 },
      }),
    ]);
  });

  it.each([
    "https://user:pass@local.example",
    "https://local.example/v3",
    "https://local.example?debug=true",
    "https://local.example#fragment",
  ])("rejects unsafe Local base URL addressing: %s", (baseURL) => {
    expect(() => createSupermemoryClient({ apiKey: "sm_fixture", baseURL }))
      .toThrow("HTTPS origin");
  });
});
