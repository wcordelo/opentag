/** Bounded, read-only Google Drive full-text search. */

import {
  verifyConnectorAuthorizationCurrent,
  type CredentialReference,
  type ImmutableConnectorLabels,
} from "../../connectors/authorization.js";
import type { AccessBundle } from "../../config/access-bundle.js";
import { resolveCredentialBearer, type CredentialBroker } from "../../connectors/credential-broker.js";
import { bindCitationAuthorization, type KnowledgeCitationBase } from "../knowledge-contract.js";
import { driveSourceKey } from "../knowledge-source-types.js";

export const DRIVE_SEARCH_LIMITS = Object.freeze({
  maxQueryLength: 512,
  maxLimit: 10,
  defaultLimit: 5,
});

export class DriveConnectorError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(code);
    this.name = "DriveConnectorError";
  }
}

type DriveFile = {
  id?: unknown;
  name?: unknown;
  mimeType?: unknown;
  modifiedTime?: unknown;
  webViewLink?: unknown;
  description?: unknown;
};

function driveLiteral(query: string): string {
  return `'${query.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function boundedExcerpt(file: DriveFile): string {
  const name = typeof file.name === "string" ? file.name : "Untitled Drive file";
  const description = typeof file.description === "string" ? file.description : "";
  return `${name}${description ? ` — ${description}` : ""}`.slice(0, 1_000);
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new DriveConnectorError(`drive_${field}_invalid`, false);
  }
  return value;
}

export async function searchGoogleDrive(input: {
  workspaceId: string;
  projectId: string;
  query: string;
  limit?: number;
  labels: ImmutableConnectorLabels;
  bundle: AccessBundle;
  credential: CredentialReference;
  credentialBroker?: CredentialBroker;
  brokerAuthToken?: string;
  fetchImpl?: typeof fetch;
  revalidate?: () => Promise<void>;
  now?: number;
}): Promise<KnowledgeCitationBase[]> {
  const query = input.query.trim();
  if (!query || query.length > DRIVE_SEARCH_LIMITS.maxQueryLength) {
    throw new DriveConnectorError("drive_query_invalid", false);
  }
  const limit = Math.min(
    DRIVE_SEARCH_LIMITS.maxLimit,
    Math.max(1, input.limit ?? DRIVE_SEARCH_LIMITS.defaultLimit),
  );
  if (input.labels.connectorId !== "google_drive" || input.labels.action !== "search") {
    throw new DriveConnectorError("drive_authorization_mismatch", false);
  }
  if (!input.credential.scopes.includes("drive.readonly")) {
    throw new DriveConnectorError("drive_read_scope_missing", false);
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const verifyAtBoundary = async () => {
    if (input.revalidate) {
      await input.revalidate();
      return;
    }
    await verifyConnectorAuthorizationCurrent({
      labels: input.labels,
      bundle: input.bundle,
      credential: input.credential,
      now: input.now,
    });
  };
  await verifyAtBoundary().catch((error) => {
    if (error instanceof Error && error.message === "credential_reference_revoked") {
      throw new DriveConnectorError(error.message, false);
    }
    throw error;
  });
  const accessToken = await resolveCredentialBearer(
    input.credentialBroker,
    input.credential,
    input.labels,
    { brokerAuthToken: input.brokerAuthToken },
  );
  const params = new URLSearchParams({
    q: `trashed = false and fullText contains ${driveLiteral(query)}`,
    spaces: "drive",
    corpora: "user",
    pageSize: String(limit),
    orderBy: "modifiedTime desc",
    includeItemsFromAllDrives: "true",
    supportsAllDrives: "true",
    fields: "files(id,name,mimeType,modifiedTime,webViewLink,description)",
  });
  const response = await fetchImpl(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
  if (response.status === 401 || response.status === 403) {
    throw new DriveConnectorError("drive_authorization_rejected", false);
  }
  if (!response.ok) throw new DriveConnectorError("drive_search_failed", response.status >= 500 || response.status === 429);
  const body = await response.json() as { files?: unknown };
  if (!Array.isArray(body.files)) throw new DriveConnectorError("drive_response_invalid", false);
  const retrievedAt = new Date().toISOString();
  const citations = body.files.slice(0, limit).map((raw) => {
    if (!raw || typeof raw !== "object") throw new DriveConnectorError("drive_file_invalid", false);
    const file = raw as DriveFile;
    const fileId = stringField(file.id, "file_id");
    const modifiedTime = typeof file.modifiedTime === "string" ? file.modifiedTime : "unknown";
    const webViewLink = typeof file.webViewLink === "string" ? file.webViewLink : undefined;
    const citation: KnowledgeCitationBase = {
      sourceKey: driveSourceKey(input.workspaceId, input.projectId, fileId),
      sourceType: "drive",
      projectId: input.projectId,
      contentRevision: `drive:${modifiedTime}:${fileId}`,
      excerpt: boundedExcerpt(file),
      aclPolicyRef: `bundle:${input.labels.accessBundleId}`,
      retrievedAt,
      ...(webViewLink ? { permalink: webViewLink, sourceUrl: webViewLink } : {}),
      fileId,
      ...(typeof file.mimeType === "string" ? { mimeType: file.mimeType } : {}),
    };
    return bindCitationAuthorization(citation, input.labels);
  });
  // Close the revocation race before returning any result to the model.
  await verifyAtBoundary();
  return citations;
}
