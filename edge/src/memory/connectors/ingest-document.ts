/**
 * Shared Local add for normalized multi-source documents (K2 Phase 2).
 */

import type { FlatMetadata, LocalDocumentStatus } from "../knowledge-contract.js";
import { parseLocalDocumentStatus, workspaceTag } from "../knowledge-contract.js";
import type { KnowledgeNormalizedDocument } from "../knowledge-connector.js";
import type { SupermemoryClient } from "../supermemory-client.js";
import { SupermemoryAdapterError } from "../supermemory-adapter.js";

export async function addNormalizedDocument(
  client: SupermemoryClient,
  input: { teamId: string; document: KnowledgeNormalizedDocument },
): Promise<{ localDocumentId: string; status: LocalDocumentStatus }> {
  if (input.document.metadata.workspaceId !== input.teamId) {
    throw new Error("metadata workspace does not match team");
  }
  if (input.document.metadata.sourceKey !== input.document.sourceKey) {
    throw new Error("metadata sourceKey mismatch");
  }
  try {
    const response = await client.add({
      content: input.document.content,
      containerTag: workspaceTag(input.teamId),
      customId: input.document.sourceKey,
      metadata: input.document.metadata as FlatMetadata,
    });
    if (!response || typeof response.id !== "string" || !response.id) {
      throw new SupermemoryAdapterError("local_malformed_response", false);
    }
    let status: LocalDocumentStatus;
    try {
      status = parseLocalDocumentStatus(response.status);
    } catch {
      throw new SupermemoryAdapterError("local_malformed_response", false);
    }
    if (status !== "queued") throw new SupermemoryAdapterError("local_malformed_response", false);
    return { localDocumentId: response.id, status };
  } catch (error) {
    if (error instanceof SupermemoryAdapterError) throw error;
    const statusCode = typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : undefined;
    const retryable = statusCode === undefined || statusCode === 408 || statusCode === 409 ||
      statusCode === 429 || (typeof statusCode === "number" && statusCode >= 500);
    throw new SupermemoryAdapterError(retryable ? "knowledge_unavailable" : "local_rejected", retryable);
  }
}
