import { describe, expect, it } from "vitest";
import {
  assertMemoryDeletionSourceReceiptMatches,
  MemoryDeletionContractError,
  validateMemoryDeletionSourceReceipt,
  validateMemoryDeletionSourceRequest,
} from "../src/platform/memory-deletion-contract.js";

const request = {
  schemaVersion: 1,
  operation: "delete",
  requestId: "deletion-1",
  idempotencyKey: "memory-delete:T1:deletion-1:slack:T1:C1:123",
  tenantId: "T1",
  sourceKey: "slack:T1:C1:123",
  deletionEpoch: 2,
  requestedAt: "2026-08-01T20:00:00.000Z",
};

const receipt = {
  schemaVersion: 1,
  idempotencyKey: request.idempotencyKey,
  requestId: request.requestId,
  tenantId: request.tenantId,
  sourceKey: request.sourceKey,
  deletionEpoch: request.deletionEpoch,
  status: "deleted",
  observedAt: "2026-08-01T20:00:01.000Z",
  receiptRef: "memory-provider:deletion-1",
};

describe("memory deletion executor contract", () => {
  it("accepts one source-scoped, content-free deletion request", () => {
    expect(validateMemoryDeletionSourceRequest(request)).toEqual(request);
  });

  it("rejects content, credentials, and unreviewed fields", () => {
    expect(() => validateMemoryDeletionSourceRequest({
      ...request,
      content: "do not forward memory",
    })).toThrow("memory_deletion_source_request_field_invalid");
    expect(() => validateMemoryDeletionSourceRequest({
      ...request,
      token: "never",
    })).toThrow("memory_deletion_source_request_field_invalid");
    expect(validateMemoryDeletionSourceRequest({
      ...request,
      sourceKey: "wiki:T1:S1:page with spaces",
    }).sourceKey).toBe("wiki:T1:S1:page with spaces");
    expect(() => validateMemoryDeletionSourceRequest({
      ...request,
      sourceKey: "wiki:T1:S1:bad\u0000key",
    })).toThrow("source_key_invalid");
  });

  it("requires an opaque provider receipt for successful outcomes", () => {
    expect(validateMemoryDeletionSourceReceipt(receipt)).toEqual(receipt);
    expect(() => validateMemoryDeletionSourceReceipt({
      ...receipt,
      receiptRef: undefined,
    })).toThrow("memory_deletion_receipt_ref_required");
    expect(validateMemoryDeletionSourceReceipt({
      ...receipt,
      status: "failed",
      errorCode: "provider_unavailable",
      receiptRef: undefined,
    })).toMatchObject({ status: "failed", errorCode: "provider_unavailable" });
  });

  it("binds the receipt to the exact request and epoch", () => {
    const parsedRequest = validateMemoryDeletionSourceRequest(request);
    const parsedReceipt = validateMemoryDeletionSourceReceipt(receipt);
    expect(() => assertMemoryDeletionSourceReceiptMatches(parsedRequest, parsedReceipt)).not.toThrow();
    expect(() => assertMemoryDeletionSourceReceiptMatches(
      parsedRequest,
      validateMemoryDeletionSourceReceipt({ ...receipt, deletionEpoch: 3 }),
    )).toThrow("memory_deletion_receipt_mismatch");
  });

  it("uses stable contract errors", () => {
    try {
      validateMemoryDeletionSourceRequest({ ...request, operation: "read" });
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryDeletionContractError);
      expect((error as MemoryDeletionContractError).code).toBe("memory_deletion_operation_invalid");
    }
  });
});
