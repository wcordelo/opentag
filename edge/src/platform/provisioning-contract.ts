/**
 * Authenticated, step-scoped tenant provisioning adapter protocol.
 *
 * The platform ledger owns tenant status and required-step receipts. This
 * boundary carries one bounded provisioning step at a time to an external
 * bootstrap adapter. It never carries provider credentials or a generic
 * provisioning payload.
 */

import {
  validateProvisioningRequest,
  validateProvisioningStepReceipt,
  type ProvisioningRequest,
  type ProvisioningStep,
  type ProvisioningStepReceipt,
} from "./layer3-contract.js";

export type { ProvisioningStepReceipt } from "./layer3-contract.js";

export const PROVISIONING_ADAPTER_SCHEMA_VERSION = 1 as const;

const MAX_IDENTIFIER_LENGTH = 256;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class ProvisioningContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProvisioningContractError";
  }
}

export type ProvisioningStepRequest = Readonly<{
  schemaVersion: typeof PROVISIONING_ADAPTER_SCHEMA_VERSION;
  operation: "provision_step";
  requestId: string;
  idempotencyKey: string;
  externalPlatform: "slack";
  externalTenantId: string;
  requestedByExternalSubject: string;
  isolationMode: ProvisioningRequest["isolationMode"];
  custodyBackend: ProvisioningRequest["custodyBackend"];
  step: ProvisioningStep;
  requestedAt: string;
}>;

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProvisioningContractError(code);
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
    throw new ProvisioningContractError(`${field}_invalid`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = identifier(value, field, 32);
  if (!ISO_RE.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new ProvisioningContractError(`${field}_invalid`);
  }
  return result;
}

function assertExactFields(input: Record<string, unknown>, allowed: readonly string[], code: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(input).some((key) => !allowedSet.has(key))) {
    throw new ProvisioningContractError(code);
  }
}

function baseProvisioningRequest(input: Record<string, unknown>): ProvisioningRequest {
  try {
    return validateProvisioningRequest({
      schemaVersion: input.schemaVersion,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      externalPlatform: input.externalPlatform,
      externalTenantId: input.externalTenantId,
      requestedByExternalSubject: input.requestedByExternalSubject,
      isolationMode: input.isolationMode,
      custodyBackend: input.custodyBackend,
      requestedAt: input.requestedAt,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string") {
      throw new ProvisioningContractError(error.code);
    }
    throw new ProvisioningContractError("provisioning_request_invalid");
  }
}

export function validateProvisioningStepRequest(value: unknown): ProvisioningStepRequest {
  const input = object(value, "provisioning_step_request_invalid");
  assertExactFields(
    input,
    ["schemaVersion", "operation", "requestId", "idempotencyKey", "externalPlatform", "externalTenantId", "requestedByExternalSubject", "isolationMode", "custodyBackend", "step", "requestedAt"],
    "provisioning_step_request_field_invalid",
  );
  if (input.schemaVersion !== PROVISIONING_ADAPTER_SCHEMA_VERSION) {
    throw new ProvisioningContractError("provisioning_step_schema_invalid");
  }
  if (input.operation !== "provision_step") {
    throw new ProvisioningContractError("provisioning_operation_invalid");
  }
  const request = baseProvisioningRequest(input);
  const step = input.step as ProvisioningStep;
  const allowedSteps: readonly ProvisioningStep[] = [
    "tenant_locator",
    "workspace_config",
    "bot_state",
    "session_events",
    "knowledge_namespace",
    "slack_oauth_install",
    "identity_custody",
    "default_access_bundle",
  ];
  if (!allowedSteps.includes(step)) {
    throw new ProvisioningContractError("provisioning_step_invalid");
  }
  return Object.freeze({
    schemaVersion: PROVISIONING_ADAPTER_SCHEMA_VERSION,
    operation: "provision_step",
    requestId: identifier(request.requestId, "request_id"),
    idempotencyKey: identifier(request.idempotencyKey, "idempotency_key"),
    externalPlatform: request.externalPlatform,
    externalTenantId: identifier(request.externalTenantId, "external_tenant_id"),
    requestedByExternalSubject: identifier(request.requestedByExternalSubject, "requested_by_external_subject"),
    isolationMode: request.isolationMode,
    custodyBackend: request.custodyBackend,
    step,
    requestedAt: timestamp(request.requestedAt, "requested_at"),
  });
}

export function validateProvisioningAdapterReceipt(value: unknown): ProvisioningStepReceipt {
  const input = object(value, "provisioning_adapter_receipt_invalid");
  assertExactFields(
    input,
    ["schemaVersion", "idempotencyKey", "step", "outcome", "retryable", "externalReceiptRef", "observedAt"],
    "provisioning_adapter_receipt_field_invalid",
  );
  try {
    return validateProvisioningStepReceipt(input);
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string") {
      throw new ProvisioningContractError(error.code);
    }
    throw new ProvisioningContractError("provisioning_adapter_receipt_invalid");
  }
}

export function assertProvisioningAdapterReceiptMatches(
  request: ProvisioningStepRequest,
  receipt: ProvisioningStepReceipt,
): void {
  if (receipt.idempotencyKey !== request.idempotencyKey || receipt.step !== request.step) {
    throw new ProvisioningContractError("provisioning_adapter_receipt_mismatch");
  }
}
