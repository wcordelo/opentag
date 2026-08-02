/**
 * Authenticated source-scoped memory deletion adapter protocol.
 *
 * The platform ledger owns the deletion request, epoch, and completion proof.
 * This boundary carries one requested source at a time to an external memory
 * provider. It never carries memory contents, search text, provider tokens,
 * or a generic payload.
 */

import {
  validateMemoryDeletionReceipt,
  type MemoryDeletionReceipt,
} from "./layer3-contract.js";

export type { MemoryDeletionReceipt } from "./layer3-contract.js";

export const MEMORY_DELETION_EXECUTOR_SCHEMA_VERSION = 1 as const;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_SOURCE_KEY_LENGTH = 128;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class MemoryDeletionContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MemoryDeletionContractError";
  }
}

export type MemoryDeletionSourceRequest = Readonly<{
  schemaVersion: typeof MEMORY_DELETION_EXECUTOR_SCHEMA_VERSION;
  operation: "delete";
  requestId: string;
  idempotencyKey: string;
  tenantId: string;
  sourceKey: string;
  deletionEpoch: number;
  requestedAt: string;
}>;

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryDeletionContractError(code);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, field: string, max = MAX_IDENTIFIER_LENGTH): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    CONTROL_RE.test(value)
  ) {
    throw new MemoryDeletionContractError(`${field}_invalid`);
  }
  return value;
}

function sourceKey(value: unknown): string {
  return identifier(value, "source_key", MAX_SOURCE_KEY_LENGTH);
}

function timestamp(value: unknown, field: string): string {
  const result = identifier(value, field, 32);
  if (!ISO_RE.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new MemoryDeletionContractError(`${field}_invalid`);
  }
  return result;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new MemoryDeletionContractError(`${field}_invalid`);
  }
  return value as number;
}

function assertExactFields(input: Record<string, unknown>, allowed: readonly string[], code: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(input).some((key) => !allowedSet.has(key))) {
    throw new MemoryDeletionContractError(code);
  }
}

export function validateMemoryDeletionSourceRequest(value: unknown): MemoryDeletionSourceRequest {
  const input = object(value, "memory_deletion_source_request_invalid");
  assertExactFields(
    input,
    ["schemaVersion", "operation", "requestId", "idempotencyKey", "tenantId", "sourceKey", "deletionEpoch", "requestedAt"],
    "memory_deletion_source_request_field_invalid",
  );
  if (input.schemaVersion !== MEMORY_DELETION_EXECUTOR_SCHEMA_VERSION) {
    throw new MemoryDeletionContractError("memory_deletion_source_schema_invalid");
  }
  if (input.operation !== "delete") {
    throw new MemoryDeletionContractError("memory_deletion_operation_invalid");
  }
  return Object.freeze({
    schemaVersion: MEMORY_DELETION_EXECUTOR_SCHEMA_VERSION,
    operation: "delete",
    requestId: identifier(input.requestId, "request_id"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotency_key"),
    tenantId: identifier(input.tenantId, "tenant_id"),
    sourceKey: sourceKey(input.sourceKey),
    deletionEpoch: nonNegativeInteger(input.deletionEpoch, "deletion_epoch"),
    requestedAt: timestamp(input.requestedAt, "requested_at"),
  });
}

export function validateMemoryDeletionSourceReceipt(value: unknown): MemoryDeletionReceipt {
  const input = object(value, "memory_deletion_source_receipt_invalid");
  assertExactFields(
    input,
    ["schemaVersion", "idempotencyKey", "requestId", "tenantId", "sourceKey", "deletionEpoch", "status", "observedAt", "receiptRef", "errorCode"],
    "memory_deletion_source_receipt_field_invalid",
  );
  const receipt = validateMemoryDeletionReceipt(input);
  if ((receipt.status === "deleted" || receipt.status === "not_found") && receipt.receiptRef === undefined) {
    throw new MemoryDeletionContractError("memory_deletion_receipt_ref_required");
  }
  return receipt;
}

export function assertMemoryDeletionSourceReceiptMatches(
  request: MemoryDeletionSourceRequest,
  receipt: MemoryDeletionReceipt,
): void {
  if (
    receipt.requestId !== request.requestId ||
    receipt.idempotencyKey !== request.idempotencyKey ||
    receipt.tenantId !== request.tenantId ||
    receipt.sourceKey !== request.sourceKey ||
    receipt.deletionEpoch !== request.deletionEpoch
  ) {
    throw new MemoryDeletionContractError("memory_deletion_receipt_mismatch");
  }
}
