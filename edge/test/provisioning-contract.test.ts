import { describe, expect, it } from "vitest";
import {
  assertProvisioningAdapterReceiptMatches,
  ProvisioningContractError,
  validateProvisioningAdapterReceipt,
  validateProvisioningStepRequest,
} from "../src/platform/provisioning-contract.js";

const request = {
  schemaVersion: 1,
  operation: "provision_step",
  requestId: "provision-1",
  idempotencyKey: "provision-key-1",
  externalPlatform: "slack",
  externalTenantId: "T_EXTERNAL",
  requestedByExternalSubject: "U_ADMIN",
  isolationMode: "shared_worker_per_tenant_do",
  custodyBackend: "external_kms",
  step: "tenant_locator",
  requestedAt: "2026-08-01T20:00:00.000Z",
};

const receipt = {
  schemaVersion: 1,
  idempotencyKey: request.idempotencyKey,
  step: request.step,
  outcome: "complete",
  retryable: false,
  externalReceiptRef: "bootstrap:tenant-locator-1",
  observedAt: "2026-08-01T20:00:01.000Z",
};

describe("provisioning adapter contract", () => {
  it("accepts a single allowlisted provisioning step", () => {
    expect(validateProvisioningStepRequest(request)).toEqual(request);
  });

  it("rejects generic payloads, credentials, and unknown steps", () => {
    expect(() => validateProvisioningStepRequest({ ...request, resourcePayload: {} }))
      .toThrow("provisioning_step_request_field_invalid");
    expect(() => validateProvisioningStepRequest({ ...request, token: "never" }))
      .toThrow("provisioning_step_request_field_invalid");
    expect(() => validateProvisioningStepRequest({ ...request, step: "arbitrary_resource" }))
      .toThrow("provisioning_step_invalid");
  });

  it("requires a bounded opaque receipt and correlates it to the step", () => {
    const parsedRequest = validateProvisioningStepRequest(request);
    const parsedReceipt = validateProvisioningAdapterReceipt(receipt);
    expect(() => assertProvisioningAdapterReceiptMatches(parsedRequest, parsedReceipt)).not.toThrow();
    expect(() => assertProvisioningAdapterReceiptMatches(
      parsedRequest,
      validateProvisioningAdapterReceipt({ ...receipt, step: "workspace_config" }),
    )).toThrow("provisioning_adapter_receipt_mismatch");
  });

  it("keeps contract errors stable", () => {
    try {
      validateProvisioningStepRequest({ ...request, operation: "delete" });
    } catch (error) {
      expect(error).toBeInstanceOf(ProvisioningContractError);
      expect((error as ProvisioningContractError).code).toBe("provisioning_operation_invalid");
    }
  });
});
