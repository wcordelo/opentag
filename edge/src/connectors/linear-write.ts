/**
 * Guarded Linear issue creation.
 *
 * The edge Worker never receives a Linear token from a tool caller. A caller
 * first obtains a short-lived, durable HITL approval record and then this
 * connector resolves the approved credential reference through the broker.
 * The approval is bound to the exact turn and normalized issue fields. The
 * connector revalidates the immutable labels after Linear responds so a
 * revocation or access-bundle change cannot be hidden by a successful write.
 */
import {
  verifyConnectorAuthorizationCurrent,
  type CredentialReference,
  type ImmutableConnectorLabels,
} from "./authorization.js";
import type { AccessBundle } from "../config/access-bundle.js";
import { resolveCredentialBearer, type CredentialBroker } from "./credential-broker.js";

export const LINEAR_WRITE_SCHEMA_VERSION = 1 as const;
export const LINEAR_WRITE_APPROVAL_TTL_MS = 5 * 60_000;

export const LINEAR_WRITE_LIMITS = Object.freeze({
  maxTitleLength: 256,
  maxDescriptionLength: 20_000,
  maxTeamLength: 256,
  maxAssigneeEmailLength: 320,
  maxProjectLength: 256,
  maxMilestoneLength: 256,
});

export type LinearIssueDraft = Readonly<{
  title: string;
  description?: string;
  /** Linear team UUID, key, or display name. */
  team?: string;
  assigneeEmail?: string;
  /** Linear project UUID or exact display name. */
  project?: string;
  /** Linear project-milestone UUID or exact display name. */
  milestone?: string;
}>;

export type LinearWriteApproval = Readonly<{
  schemaVersion: typeof LINEAR_WRITE_SCHEMA_VERSION;
  approvalId: string;
  connectorId: "linear";
  action: "create_issue";
  teamId: string;
  channelId: string;
  requesterId: string;
  actorKind: "human";
  executionId: string;
  threadKey: string;
  draft: LinearIssueDraft;
  draftDigest: string;
  approvedAt: string;
  expiresAt: string;
}>;

export type LinearIssueCreateResult = Readonly<{
  id: string;
  identifier: string;
  title: string;
  url?: string;
}>;

export class LinearConnectorError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(code);
    this.name = "LinearConnectorError";
  }
}

function boundedText(
  value: unknown,
  field: string,
  maxLength: number,
  required = false,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new LinearConnectorError(`linear_${field}_required`, false);
    return undefined;
  }
  if (typeof value !== "string") {
    throw new LinearConnectorError(`linear_${field}_invalid`, false);
  }
  const normalized = value.trim();
  if (!normalized && required) {
    throw new LinearConnectorError(`linear_${field}_required`, false);
  }
  if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new LinearConnectorError(`linear_${field}_invalid`, false);
  }
  return normalized || undefined;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LinearConnectorError("linear_draft_invalid", false);
  }
  return value as Record<string, unknown>;
}

/** Normalize the only issue fields the guarded write path accepts. */
export function normalizeLinearIssueDraft(value: unknown): LinearIssueDraft {
  const input = record(value);
  const known = new Set(["title", "description", "team", "assigneeEmail", "project", "milestone"]);
  const unknown = Object.keys(input).find((key) => !known.has(key));
  if (unknown) throw new LinearConnectorError("linear_draft_field_invalid", false);
  const title = boundedText(input.title, "title", LINEAR_WRITE_LIMITS.maxTitleLength, true)!;
  const description = boundedText(
    input.description,
    "description",
    LINEAR_WRITE_LIMITS.maxDescriptionLength,
  );
  const team = boundedText(input.team, "team", LINEAR_WRITE_LIMITS.maxTeamLength);
  const assigneeEmail = boundedText(
    input.assigneeEmail,
    "assignee_email",
    LINEAR_WRITE_LIMITS.maxAssigneeEmailLength,
  );
  if (assigneeEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(assigneeEmail)) {
    throw new LinearConnectorError("linear_assignee_email_invalid", false);
  }
  const project = boundedText(input.project, "project", LINEAR_WRITE_LIMITS.maxProjectLength);
  const milestone = boundedText(input.milestone, "milestone", LINEAR_WRITE_LIMITS.maxMilestoneLength);
  if (milestone && !project) {
    throw new LinearConnectorError("linear_milestone_requires_project", false);
  }
  return Object.freeze({
    title,
    ...(description ? { description } : {}),
    ...(team ? { team } : {}),
    ...(assigneeEmail ? { assigneeEmail: assigneeEmail.toLowerCase() } : {}),
    ...(project ? { project } : {}),
    ...(milestone ? { milestone } : {}),
  });
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function digestLinearIssueDraft(draft: LinearIssueDraft): Promise<string> {
  const normalized = normalizeLinearIssueDraft(draft);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([
      normalized.title,
      normalized.description ?? null,
      normalized.team ?? null,
      normalized.assigneeEmail ?? null,
      normalized.project ?? null,
      normalized.milestone ?? null,
    ])),
  );
  return `sha256:${hex(new Uint8Array(digest))}`;
}

export function linearWriteApprovalKey(approvalId: string): string {
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(approvalId)) {
    throw new LinearConnectorError("linear_approval_id_invalid", false);
  }
  return `linear-write-approval:${approvalId}`;
}

export async function createLinearWriteApproval(input: {
  approvalId: string;
  teamId: string;
  channelId: string;
  requesterId: string;
  executionId: string;
  threadKey: string;
  draft: unknown;
  now?: number;
  ttlMs?: number;
}): Promise<LinearWriteApproval> {
  linearWriteApprovalKey(input.approvalId);
  const draft = normalizeLinearIssueDraft(input.draft);
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? LINEAR_WRITE_APPROVAL_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > LINEAR_WRITE_APPROVAL_TTL_MS) {
    throw new LinearConnectorError("linear_approval_ttl_invalid", false);
  }
  const approvedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMs).toISOString();
  return Object.freeze({
    schemaVersion: LINEAR_WRITE_SCHEMA_VERSION,
    approvalId: input.approvalId,
    connectorId: "linear",
    action: "create_issue",
    teamId: input.teamId,
    channelId: input.channelId,
    requesterId: input.requesterId,
    actorKind: "human",
    executionId: input.executionId,
    threadKey: input.threadKey,
    draft,
    draftDigest: await digestLinearIssueDraft(draft),
    approvedAt,
    expiresAt,
  });
}

export async function assertLinearWriteApprovalCurrent(
  value: unknown,
  expected: {
    approvalId: string;
    teamId: string;
    channelId: string;
    requesterId: string;
    executionId: string;
    threadKey: string;
    draft: unknown;
    now?: number;
  },
): Promise<LinearWriteApproval> {
  linearWriteApprovalKey(expected.approvalId);
  const input = record(value);
  if (
    input.schemaVersion !== LINEAR_WRITE_SCHEMA_VERSION ||
    input.approvalId !== expected.approvalId ||
    input.connectorId !== "linear" ||
    input.action !== "create_issue" ||
    input.actorKind !== "human" ||
    input.teamId !== expected.teamId ||
    input.channelId !== expected.channelId ||
    input.requesterId !== expected.requesterId ||
    input.executionId !== expected.executionId ||
    input.threadKey !== expected.threadKey
  ) {
    throw new LinearConnectorError("linear_approval_context_mismatch", false);
  }
  const approvedAt = boundedText(input.approvedAt, "approved_at", 64, true)!;
  const expiresAt = boundedText(input.expiresAt, "expires_at", 64, true)!;
  const now = expected.now ?? Date.now();
  if (
    !Number.isFinite(Date.parse(approvedAt)) ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(approvedAt) > now ||
    Date.parse(expiresAt) <= Date.parse(approvedAt) ||
    Date.parse(expiresAt) - Date.parse(approvedAt) > LINEAR_WRITE_APPROVAL_TTL_MS ||
    Date.parse(expiresAt) <= now
  ) {
    throw new LinearConnectorError("linear_approval_expired", false);
  }
  const draft = normalizeLinearIssueDraft(input.draft);
  const expectedDraft = normalizeLinearIssueDraft(expected.draft);
  if (await digestLinearIssueDraft(draft) !== input.draftDigest || await digestLinearIssueDraft(draft) !== await digestLinearIssueDraft(expectedDraft)) {
    throw new LinearConnectorError("linear_approval_draft_mismatch", false);
  }
  return Object.freeze({
    schemaVersion: LINEAR_WRITE_SCHEMA_VERSION,
    approvalId: expected.approvalId,
    connectorId: "linear",
    action: "create_issue",
    teamId: expected.teamId,
    channelId: expected.channelId,
    requesterId: expected.requesterId,
    actorKind: "human",
    executionId: expected.executionId,
    threadKey: expected.threadKey,
    draft,
    draftDigest: input.draftDigest as string,
    approvedAt,
    expiresAt,
  });
}

type GraphqlResponse<T> = {
  data?: T;
  errors?: readonly unknown[];
};

type LinearReference = { id?: unknown; name?: unknown; key?: unknown; email?: unknown };

function stringValue(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || !value || value.length > max) {
    throw new LinearConnectorError(`linear_${field}_invalid`, false);
  }
  return value;
}

function looksLikeId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function exactReference(
  references: readonly LinearReference[],
  value: string,
  field: "team" | "project" | "milestone" | "assignee",
): string {
  const normalized = value.toLocaleLowerCase();
  const matches = references.filter((candidate) => {
    const fields = field === "assignee"
      ? [candidate.email]
      : field === "team"
        ? [candidate.name, candidate.key]
        : [candidate.name];
    return fields.some((entry) => typeof entry === "string" && entry.toLocaleLowerCase() === normalized);
  });
  if (matches.length !== 1) {
    throw new LinearConnectorError(
      matches.length === 0 ? `linear_${field}_not_found` : `linear_${field}_ambiguous`,
      false,
    );
  }
  return stringValue(matches[0]!.id, `${field}_id`);
}

async function graphql<T>(input: {
  token: string;
  query: string;
  variables?: Record<string, unknown>;
  fetchImpl: typeof fetch;
}): Promise<T> {
  const response = await input.fetchImpl("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: input.query, variables: input.variables ?? {} }),
  });
  if (response.status === 401 || response.status === 403) {
    throw new LinearConnectorError("linear_authorization_rejected", false);
  }
  if (response.status === 429 || response.status >= 500) {
    throw new LinearConnectorError("linear_api_unavailable", true);
  }
  if (!response.ok) throw new LinearConnectorError("linear_api_failed", false);
  const body = await response.json() as GraphqlResponse<T>;
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new LinearConnectorError("linear_graphql_rejected", false);
  }
  if (!body.data) throw new LinearConnectorError("linear_response_invalid", false);
  return body.data;
}

async function resolveReferences(input: {
  token: string;
  draft: LinearIssueDraft;
  fetchImpl: typeof fetch;
}): Promise<{ teamId: string; assigneeId?: string; projectId?: string; milestoneId?: string }> {
  if (!input.draft.team) throw new LinearConnectorError("linear_team_required", false);
  const teamId = looksLikeId(input.draft.team)
    ? input.draft.team
    : undefined;
  const projectId = input.draft.project && looksLikeId(input.draft.project)
    ? input.draft.project
    : undefined;
  const milestoneId = input.draft.milestone && looksLikeId(input.draft.milestone)
    ? input.draft.milestone
    : undefined;
  if (teamId && (!input.draft.assigneeEmail || looksLikeId(input.draft.assigneeEmail)) &&
      (!input.draft.project || projectId) && (!input.draft.milestone || milestoneId)) {
    return { teamId, ...(projectId ? { projectId } : {}), ...(milestoneId ? { milestoneId } : {}) };
  }

  const needTeam = !teamId;
  const needAssignee = Boolean(input.draft.assigneeEmail && !looksLikeId(input.draft.assigneeEmail));
  const needProject = Boolean(input.draft.project && !projectId);
  const needMilestone = Boolean(input.draft.milestone && !milestoneId);
  const selections = [
    needTeam ? "teams(first: 100) { nodes { id name key } }" : "",
    needAssignee ? "users(first: 100) { nodes { id email name } }" : "",
    needProject || needMilestone
      ? `projects(first: 100) {
          nodes {
            id name
            ${needMilestone ? "projectMilestones(first: 100) { nodes { id name } }" : ""}
          }
        }`
      : "",
  ].filter(Boolean).join("\n");
  const data = await graphql<{
    teams?: { nodes?: readonly LinearReference[] };
    users?: { nodes?: readonly LinearReference[] };
    projects?: { nodes?: readonly (LinearReference & {
      projectMilestones?: { nodes?: readonly LinearReference[] };
    })[] };
  }>({
    token: input.token,
    fetchImpl: input.fetchImpl,
    query: `query ResolveLinearReferences {\n${selections}\n}`,
  });
  const resolvedTeamId = teamId ?? exactReference(data.teams?.nodes ?? [], input.draft.team, "team");
  const resolvedAssigneeId = input.draft.assigneeEmail
    ? (looksLikeId(input.draft.assigneeEmail)
      ? input.draft.assigneeEmail
      : exactReference(data.users?.nodes ?? [], input.draft.assigneeEmail, "assignee"))
    : undefined;
  const resolvedProjectId = input.draft.project
    ? (projectId ?? exactReference(data.projects?.nodes ?? [], input.draft.project, "project"))
    : undefined;
  let resolvedMilestoneId = milestoneId;
  if (input.draft.milestone && !resolvedMilestoneId) {
    const project = (data.projects?.nodes ?? []).find((candidate) => candidate.id === resolvedProjectId);
    resolvedMilestoneId = exactReference(project?.projectMilestones?.nodes ?? [], input.draft.milestone, "milestone");
  }
  return {
    teamId: resolvedTeamId,
    ...(resolvedAssigneeId ? { assigneeId: resolvedAssigneeId } : {}),
    ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
    ...(resolvedMilestoneId ? { milestoneId: resolvedMilestoneId } : {}),
  };
}

export async function createLinearIssue(input: {
  labels: ImmutableConnectorLabels;
  bundle: AccessBundle;
  credential: CredentialReference;
  credentialBroker?: CredentialBroker;
  draft: unknown;
  fetchImpl?: typeof fetch;
  revalidate?: () => Promise<void>;
  now?: number;
}): Promise<LinearIssueCreateResult> {
  const draft = normalizeLinearIssueDraft(input.draft);
  if (input.labels.connectorId !== "linear" || input.labels.action !== "create_issue") {
    throw new LinearConnectorError("linear_authorization_mismatch", false);
  }
  if (input.credential.provider !== "linear") {
    throw new LinearConnectorError("linear_credential_provider_mismatch", false);
  }
  if (!input.credential.scopes.includes("issues:create") && !input.credential.scopes.includes("write")) {
    throw new LinearConnectorError("linear_issue_create_scope_missing", false);
  }
  await verifyConnectorAuthorizationCurrent({
    labels: input.labels,
    bundle: input.bundle,
    credential: input.credential,
    now: input.now,
  });
  const token = await resolveCredentialBearer(input.credentialBroker, input.credential, input.labels);
  const fetchImpl = input.fetchImpl ?? fetch;
  const references = await resolveReferences({ token, draft, fetchImpl });
  const response = await graphql<{
    issueCreate?: {
      success?: unknown;
      issue?: { id?: unknown; identifier?: unknown; title?: unknown; url?: unknown };
    };
  }>({
    token,
    fetchImpl,
    query: `mutation CreateLinearIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier title url }
      }
    }`,
    variables: {
      input: {
        title: draft.title,
        ...(draft.description ? { description: draft.description } : {}),
        teamId: references.teamId,
        ...(references.assigneeId ? { assigneeId: references.assigneeId } : {}),
        ...(references.projectId ? { projectId: references.projectId } : {}),
        ...(references.milestoneId ? { projectMilestoneId: references.milestoneId } : {}),
      },
    },
  });
  if (response.issueCreate?.success !== true || !response.issueCreate.issue) {
    throw new LinearConnectorError("linear_issue_create_rejected", false);
  }
  const issue = response.issueCreate.issue;
  const result = Object.freeze({
    id: stringValue(issue.id, "issue_id"),
    identifier: stringValue(issue.identifier, "issue_identifier"),
    title: stringValue(issue.title, "issue_title", LINEAR_WRITE_LIMITS.maxTitleLength),
    ...(typeof issue.url === "string" && issue.url.length <= 2_048 ? { url: issue.url } : {}),
  });
  if (input.revalidate) {
    await input.revalidate();
  } else {
    await verifyConnectorAuthorizationCurrent({
      labels: input.labels,
      bundle: input.bundle,
      credential: input.credential,
      now: input.now,
    });
  }
  return result;
}
