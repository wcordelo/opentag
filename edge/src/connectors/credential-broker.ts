/**
 * Internal credential-injection protocol.
 *
 * OpenTag stores and passes only a credential reference. A separately deployed
 * service binding resolves that reference into short-lived material at the
 * last possible moment. This module validates the response and never logs or
 * persists the returned token.
 */

import type {
  CredentialReference,
  ImmutableConnectorLabels,
} from "./authorization.js";
import {
  validateCredentialCustodyReference,
  type CredentialCustodyReference,
} from "../platform/layer3-contract.js";

export const CREDENTIAL_BROKER_SCHEMA_VERSION = 1 as const;

export type CredentialBroker = Pick<Fetcher, "fetch">;

export type CredentialBrokerRequest = Readonly<{
  schemaVersion: typeof CREDENTIAL_BROKER_SCHEMA_VERSION;
  reference: Readonly<{
    ref: string;
    version: number;
  }>;
  labels: ImmutableConnectorLabels;
}>;

export type CredentialBrokerResponse = Readonly<{
  schemaVersion: typeof CREDENTIAL_BROKER_SCHEMA_VERSION;
  ref: string;
  version: number;
  accessToken: string;
  expiresAt?: string;
}>;

/**
 * Metadata-only request from the credential broker to an approved custody
 * adapter. The token itself is never a valid field in this contract.
 */
export type CredentialCustodyResolveRequest = Readonly<{
  schemaVersion: typeof CREDENTIAL_BROKER_SCHEMA_VERSION;
  tenantId: string;
  reference: Readonly<{ ref: string; version: number }>;
  labels: ImmutableConnectorLabels;
  credential: CredentialCustodyReference;
}>;

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field}_invalid`);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, field: string, max = 512): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

function version(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field}_invalid`);
  }
  return value as number;
}

function timestamp(value: unknown, field: string): string {
  const result = identifier(value, field, 32);
  const parsed = Date.parse(result);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) {
    throw new Error(`${field}_invalid`);
  }
  return result;
}

function validateLabels(value: unknown): ImmutableConnectorLabels {
  const input = object(value, "connector_labels");
  if (input.schemaVersion !== 1) throw new Error("connector_labels_schema_invalid");
  const scope = input.scope;
  if (scope !== "workspace" && scope !== "project" && scope !== "channel") {
    throw new Error("connector_labels_scope_invalid");
  }
  const actorKind = input.actorKind;
  if (actorKind !== "human" && actorKind !== "service" && actorKind !== "automation") {
    throw new Error("connector_labels_actor_invalid");
  }
  const digest = identifier(input.digest, "connector_labels_digest", 80);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error("connector_labels_digest_invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    workspaceId: identifier(input.workspaceId, "workspace_id"),
    projectId: identifier(input.projectId, "project_id"),
    channelId: identifier(input.channelId, "channel_id"),
    connectorId: identifier(input.connectorId, "connector_id"),
    action: identifier(input.action, "connector_action"),
    scope,
    requesterId: identifier(input.requesterId, "requester_id"),
    actorKind,
    executionId: identifier(input.executionId, "execution_id"),
    threadKey: identifier(input.threadKey, "thread_key"),
    accessBundleId: identifier(input.accessBundleId, "access_bundle_id"),
    accessBundleRevision: version(input.accessBundleRevision, "access_bundle_revision"),
    ...(input.credentialRef === undefined
      ? {}
      : { credentialRef: identifier(input.credentialRef, "credential_ref") }),
    ...(input.credentialVersion === undefined
      ? {}
      : { credentialVersion: version(input.credentialVersion, "credential_version") }),
    issuedAt: timestamp(input.issuedAt, "connector_issued_at"),
    expiresAt: timestamp(input.expiresAt, "connector_expires_at"),
    digest,
  });
}

export function validateCredentialBrokerRequest(value: unknown): CredentialBrokerRequest {
  const input = object(value, "credential_broker_request");
  if (input.schemaVersion !== CREDENTIAL_BROKER_SCHEMA_VERSION) {
    throw new Error("credential_broker_schema_invalid");
  }
  const reference = object(input.reference, "credential_reference");
  const ref = identifier(reference.ref, "credential_ref");
  const credentialVersion = version(reference.version, "credential_version");
  const labels = validateLabels(input.labels);
  if (labels.credentialRef !== ref || labels.credentialVersion !== credentialVersion) {
    throw new Error("credential_broker_reference_mismatch");
  }
  return Object.freeze({
    schemaVersion: CREDENTIAL_BROKER_SCHEMA_VERSION,
    reference: Object.freeze({ ref, version: credentialVersion }),
    labels,
  });
}

export function validateCredentialBrokerResponse(value: unknown): CredentialBrokerResponse {
  const input = object(value, "credential_broker_response");
  if (input.schemaVersion !== CREDENTIAL_BROKER_SCHEMA_VERSION) {
    throw new Error("connector_credential_resolution_invalid");
  }
  const accessToken = identifier(input.accessToken, "credential_access_token", 16_384);
  const response: CredentialBrokerResponse = {
    schemaVersion: CREDENTIAL_BROKER_SCHEMA_VERSION,
    ref: identifier(input.ref, "credential_ref"),
    version: version(input.version, "credential_version"),
    accessToken,
    ...(input.expiresAt === undefined
      ? {}
      : { expiresAt: timestamp(input.expiresAt, "credential_expires_at") }),
  };
  return Object.freeze(response);
}

export function validateCredentialCustodyResolveRequest(
  value: unknown,
): CredentialCustodyResolveRequest {
  const input = object(value, "credential_custody_request");
  if (input.schemaVersion !== CREDENTIAL_BROKER_SCHEMA_VERSION) {
    throw new Error("credential_custody_schema_invalid");
  }
  const tenantId = identifier(input.tenantId, "tenant_id");
  const brokerRequest = validateCredentialBrokerRequest({
    schemaVersion: CREDENTIAL_BROKER_SCHEMA_VERSION,
    reference: input.reference,
    labels: input.labels,
  });
  const credential = validateCredentialCustodyReference(input.credential);
  if (credential.tenantId !== tenantId) {
    throw new Error("credential_custody_tenant_mismatch");
  }
  if (
    credential.credentialRef !== brokerRequest.reference.ref ||
    credential.version !== brokerRequest.reference.version
  ) {
    throw new Error("credential_custody_reference_mismatch");
  }
  return Object.freeze({
    schemaVersion: CREDENTIAL_BROKER_SCHEMA_VERSION,
    tenantId,
    reference: brokerRequest.reference,
    labels: brokerRequest.labels,
    credential,
  });
}

/** Recompute the immutable label digest at every service boundary. */
export async function connectorLabelsDigest(
  labels: ImmutableConnectorLabels,
): Promise<string> {
  const { digest: _ignoredDigest, ...unsigned } = labels;
  const payload = JSON.stringify([
    unsigned.schemaVersion,
    unsigned.workspaceId,
    unsigned.projectId,
    unsigned.channelId,
    unsigned.connectorId,
    unsigned.action,
    unsigned.scope,
    unsigned.requesterId,
    unsigned.actorKind,
    unsigned.executionId,
    unsigned.threadKey,
    unsigned.accessBundleId,
    unsigned.accessBundleRevision,
    unsigned.credentialRef ?? null,
    unsigned.credentialVersion ?? null,
    unsigned.issuedAt,
    unsigned.expiresAt,
  ]);
  const computed = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return `sha256:${[...new Uint8Array(computed)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

export async function assertConnectorLabelsIntegrity(
  labels: ImmutableConnectorLabels,
): Promise<void> {
  if (await connectorLabelsDigest(labels) !== labels.digest) {
    throw new Error("connector_labels_tampered");
  }
}

export async function resolveCredentialBearer(
  broker: CredentialBroker | undefined,
  reference: CredentialReference,
  labels: ImmutableConnectorLabels,
  options?: Readonly<{ brokerAuthToken?: string }>,
): Promise<string> {
  if (!broker) throw new Error("connector_credential_broker_unavailable");
  const request = validateCredentialBrokerRequest({
    schemaVersion: CREDENTIAL_BROKER_SCHEMA_VERSION,
    reference: { ref: reference.ref, version: reference.version },
    labels,
  });
  const headers = new Headers({
    "content-type": "application/json",
    "x-opentag-connector-authorization": labels.digest,
  });
  if (options?.brokerAuthToken) {
    headers.set("authorization", `Bearer ${options.brokerAuthToken}`);
  }
  const response = await broker.fetch("https://credentials/resolve", {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error("connector_credential_resolution_failed");
  const body = validateCredentialBrokerResponse(await response.json());
  if (body.ref !== request.reference.ref || body.version !== request.reference.version) {
    throw new Error("connector_credential_resolution_invalid");
  }
  if (body.expiresAt && Date.parse(body.expiresAt) <= Date.now()) {
    throw new Error("connector_credential_resolution_expired");
  }
  return body.accessToken;
}
