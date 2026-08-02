import { describe, expect, it } from "vitest";
import {
  assertIdentityCustodyReceiptMatches,
  IdentityCustodyContractError,
  validateIdentityCustodyReceipt,
  validateIdentityCustodyRequest,
} from "../src/platform/identity-custody-contract.js";

const request = {
  schemaVersion: 1,
  operation: "provision",
  tenantId: "tenant-1",
  identityRef: "identity:tenant-1:agent",
  backend: "external_kms",
  version: 1,
  idempotencyKey: "identity-provision-1",
  requestedAt: "2026-08-01T20:00:00.000Z",
} as const;

describe("identity custody contract", () => {
  it("accepts public metadata and matches an opaque receipt", () => {
    const validated = validateIdentityCustodyRequest(request);
    const receipt = validateIdentityCustodyReceipt({
      schemaVersion: 1,
      operation: "provision",
      tenantId: "tenant-1",
      identityRef: "identity:tenant-1:agent",
      backend: "external_kms",
      version: 1,
      externalReceiptRef: "identity-receipt:provider-1",
      observedAt: "2026-08-01T20:00:01.000Z",
      publicKey: "ed25519:public-key",
    });
    expect(validated.identityRef).toBe("identity:tenant-1:agent");
    expect(receipt.publicKey).toBe("ed25519:public-key");
    expect(() => assertIdentityCustodyReceiptMatches(validated, receipt)).not.toThrow();
  });

  it("allows revocation receipts without a public key", () => {
    expect(validateIdentityCustodyReceipt({
      schemaVersion: 1,
      operation: "revoke",
      tenantId: "tenant-1",
      identityRef: "identity:tenant-1:agent",
      backend: "external_kms",
      version: 2,
      externalReceiptRef: "identity-receipt:revoke-2",
      observedAt: "2026-08-01T20:00:01.000Z",
    }).operation).toBe("revoke");
  });

  it("rejects private material, unknown fields, and receipt mismatches", () => {
    expect(() => validateIdentityCustodyRequest({
      ...request,
      privateKey: "should-not-be-accepted",
    })).toThrowError(new IdentityCustodyContractError("identity_custody_request_field_invalid"));
    expect(() => validateIdentityCustodyRequest({
      ...request,
      publicKey: "-----BEGIN PRIVATE KEY-----secret",
    })).toThrowError(new IdentityCustodyContractError("private_key_material_forbidden"));
    const validated = validateIdentityCustodyRequest(request);
    const receipt = validateIdentityCustodyReceipt({
      schemaVersion: 1,
      operation: "provision",
      tenantId: "other-tenant",
      identityRef: "identity:tenant-1:agent",
      backend: "external_kms",
      version: 1,
      externalReceiptRef: "identity-receipt:provider-1",
      observedAt: "2026-08-01T20:00:01.000Z",
      publicKey: "ed25519:public-key",
    });
    expect(() => assertIdentityCustodyReceiptMatches(validated, receipt)).toThrowError(
      new IdentityCustodyContractError("identity_custody_receipt_mismatch"),
    );
  });
});
