/**
 * Authenticated identity/key-custody adapter protocol.
 *
 * OpenTag sends only tenant-scoped public identity metadata across this
 * boundary. The provider adapter owns key generation, signing, storage, and
 * revocation outside the bot, Durable Objects, queues, and logs. Successful
 * responses contain a bounded opaque receipt and, when applicable, a public
 * key; private key material is not a valid contract value.
 */

import type { CustodyBackend } from "./layer3-contract.js";

export const IDENTITY_CUSTODY_SCHEMA_VERSION = 1 as const;

const MAX_IDENTIFIER_LENGTH = 256;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const PRIVATE_MATERIAL_RE = /private[ _-]?key|begin [^-]*private|access[ _-]?token|refresh[ _-]?token|password|secret/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class IdentityCustodyContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "IdentityCustodyContractError";
  }
}

export type IdentityCustodyOperation = "provision" | "rotate" | "revoke";

export type IdentityCustodyRequest = Readonly<{
  schemaVersion: typeof IDENTITY_CUSTODY_SCHEMA_VERSION;
  operation: IdentityCustodyOperation;
  tenantId: string;
  identityRef: `identity:${string}`;
  backend: CustodyBackend;
  version: number;
  idempotencyKey: string;
  requestedAt: string;
  /** Existing public key for registration/rotation; never a private key. */
  publicKey?: string;
}>;

export type IdentityCustodyReceipt = Readonly<{
  schemaVersion: typeof IDENTITY_CUSTODY_SCHEMA_VERSION;
  operation: IdentityCustodyOperation;
  tenantId: string;
  identityRef: `identity:${string}`;
  backend: CustodyBackend;
  version: number;
  externalReceiptRef: string;
  observedAt: string;
  /** Required for provisioning/rotation; omitted for revocation receipts. */
  publicKey?: string;
}>;

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IdentityCustodyContractError(code);
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
    throw new IdentityCustodyContractError(`${field}_invalid`);
  }
  if (PRIVATE_MATERIAL_RE.test(value)) {
    throw new IdentityCustodyContractError("private_key_material_forbidden");
  }
  return value;
}

function safePublicKey(value: unknown, field: string): string {
  const result = identifier(value, field, 8192);
  if (PRIVATE_MATERIAL_RE.test(result)) {
    throw new IdentityCustodyContractError("private_key_material_forbidden");
  }
  return result;
}

function timestamp(value: unknown, field: string): string {
  const result = identifier(value, field, 32);
  if (!ISO_RE.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new IdentityCustodyContractError(`${field}_invalid`);
  }
  return result;
}

function version(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new IdentityCustodyContractError(`${field}_invalid`);
  }
  return value as number;
}

function backend(value: unknown): CustodyBackend {
  if (value !== "external_kms" && value !== "wrapped_do_envelope" && value !== "self_hosted") {
    throw new IdentityCustodyContractError("custody_backend_invalid");
  }
  return value;
}

function operation(value: unknown): IdentityCustodyOperation {
  if (value !== "provision" && value !== "rotate" && value !== "revoke") {
    throw new IdentityCustodyContractError("identity_custody_operation_invalid");
  }
  return value;
}

function assertExactFields(input: Record<string, unknown>, allowed: readonly string[], code: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(input).some((key) => !allowedSet.has(key))) {
    throw new IdentityCustodyContractError(code);
  }
}

export function validateIdentityCustodyRequest(value: unknown): IdentityCustodyRequest {
  const input = object(value, "identity_custody_request_invalid");
  assertExactFields(
    input,
    ["schemaVersion", "operation", "tenantId", "identityRef", "backend", "version", "idempotencyKey", "requestedAt", "publicKey"],
    "identity_custody_request_field_invalid",
  );
  if (input.schemaVersion !== IDENTITY_CUSTODY_SCHEMA_VERSION) {
    throw new IdentityCustodyContractError("identity_custody_schema_invalid");
  }
  const identityRef = identifier(input.identityRef, "identity_ref");
  if (!identityRef.startsWith("identity:")) {
    throw new IdentityCustodyContractError("identity_ref_invalid");
  }
  const selectedOperation = operation(input.operation);
  return Object.freeze({
    schemaVersion: IDENTITY_CUSTODY_SCHEMA_VERSION,
    operation: selectedOperation,
    tenantId: identifier(input.tenantId, "tenant_id"),
    identityRef: identityRef as `identity:${string}`,
    backend: backend(input.backend),
    version: version(input.version, "version"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotency_key"),
    requestedAt: timestamp(input.requestedAt, "requested_at"),
    ...(input.publicKey === undefined ? {} : { publicKey: safePublicKey(input.publicKey, "public_key") }),
  });
}

export function validateIdentityCustodyReceipt(value: unknown): IdentityCustodyReceipt {
  const input = object(value, "identity_custody_receipt_invalid");
  assertExactFields(
    input,
    ["schemaVersion", "operation", "tenantId", "identityRef", "backend", "version", "externalReceiptRef", "observedAt", "publicKey"],
    "identity_custody_receipt_field_invalid",
  );
  if (input.schemaVersion !== IDENTITY_CUSTODY_SCHEMA_VERSION) {
    throw new IdentityCustodyContractError("identity_custody_receipt_schema_invalid");
  }
  const identityRef = identifier(input.identityRef, "identity_ref");
  if (!identityRef.startsWith("identity:")) {
    throw new IdentityCustodyContractError("identity_ref_invalid");
  }
  const selectedOperation = operation(input.operation);
  const publicKey = input.publicKey === undefined
    ? undefined
    : safePublicKey(input.publicKey, "public_key");
  if (selectedOperation !== "revoke" && publicKey === undefined) {
    throw new IdentityCustodyContractError("identity_public_key_required");
  }
  return Object.freeze({
    schemaVersion: IDENTITY_CUSTODY_SCHEMA_VERSION,
    operation: selectedOperation,
    tenantId: identifier(input.tenantId, "tenant_id"),
    identityRef: identityRef as `identity:${string}`,
    backend: backend(input.backend),
    version: version(input.version, "version"),
    externalReceiptRef: identifier(input.externalReceiptRef, "external_receipt_ref"),
    observedAt: timestamp(input.observedAt, "observed_at"),
    ...(publicKey === undefined ? {} : { publicKey }),
  });
}

export function assertIdentityCustodyReceiptMatches(
  request: IdentityCustodyRequest,
  receipt: IdentityCustodyReceipt,
): void {
  if (
    receipt.operation !== request.operation ||
    receipt.tenantId !== request.tenantId ||
    receipt.identityRef !== request.identityRef ||
    receipt.backend !== request.backend ||
    receipt.version !== request.version
  ) {
    throw new IdentityCustodyContractError("identity_custody_receipt_mismatch");
  }
}
