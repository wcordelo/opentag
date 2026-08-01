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

export type CredentialBroker = Pick<Fetcher, "fetch">;

export async function resolveCredentialBearer(
  broker: CredentialBroker | undefined,
  reference: CredentialReference,
  labels: ImmutableConnectorLabels,
): Promise<string> {
  if (!broker) throw new Error("connector_credential_broker_unavailable");
  const response = await broker.fetch("https://credentials/resolve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opentag-connector-authorization": labels.digest,
    },
    body: JSON.stringify({
      schemaVersion: 1,
      ref: reference.ref,
      version: reference.version,
      connectorId: labels.connectorId,
      action: labels.action,
      scope: {
        workspaceId: labels.workspaceId,
        projectId: labels.projectId,
        channelId: labels.channelId,
      },
    }),
  });
  if (!response.ok) throw new Error("connector_credential_resolution_failed");
  const body = await response.json() as {
    schemaVersion?: unknown;
    ref?: unknown;
    version?: unknown;
    accessToken?: unknown;
    expiresAt?: unknown;
  };
  if (
    body.schemaVersion !== 1 ||
    body.ref !== reference.ref ||
    body.version !== reference.version ||
    typeof body.accessToken !== "string" ||
    body.accessToken.length === 0 ||
    body.accessToken.length > 16_384
  ) {
    throw new Error("connector_credential_resolution_invalid");
  }
  if (body.expiresAt !== undefined && typeof body.expiresAt !== "string") {
    throw new Error("connector_credential_resolution_invalid");
  }
  return body.accessToken;
}
