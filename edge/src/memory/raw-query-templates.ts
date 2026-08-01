/**
 * Server-defined, read-only company-context query templates.
 *
 * This is intentionally not a SQL API. The caller chooses one of the named
 * templates and supplies only that template's bounded parameters. The
 * KnowledgeDO owns the actual statements and tenant filtering.
 */

export const RAW_QUERY_SCHEMA_VERSION = 1 as const;
export const RAW_QUERY_LIMITS = Object.freeze({
  maxIdentifierLength: 128,
  maxBodyLength: 4_000,
  maxLimit: 10,
});

export type RawKnowledgeQueryTemplate =
  | "recent_channel_memory"
  | "memory_record"
  | "source_state";

export const RAW_QUERY_TEMPLATES: readonly RawKnowledgeQueryTemplate[] = [
  "recent_channel_memory",
  "memory_record",
  "source_state",
] as const;

export type RawKnowledgeQuery = Readonly<{
  schemaVersion: typeof RAW_QUERY_SCHEMA_VERSION;
  template: RawKnowledgeQueryTemplate;
  teamId: string;
  channelId?: string;
  recordId?: string;
  sourceKey?: string;
  limit: number;
}>;

export class RawKnowledgeQueryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RawKnowledgeQueryError";
  }
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > RAW_QUERY_LIMITS.maxIdentifierLength ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new RawKnowledgeQueryError(`${field}_invalid`);
  }
  return value;
}

function optionalIdentifier(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : identifier(value, field);
}

export function parseRawKnowledgeQuery(value: unknown): RawKnowledgeQuery {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RawKnowledgeQueryError("raw_query_body_invalid");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion", "template", "teamId", "channelId", "recordId", "sourceKey", "limit",
  ]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new RawKnowledgeQueryError(`raw_query_field_forbidden:${unknown}`);
  if (input.schemaVersion !== undefined && input.schemaVersion !== RAW_QUERY_SCHEMA_VERSION) {
    throw new RawKnowledgeQueryError("raw_query_schema_invalid");
  }
  if (typeof input.template !== "string" || !RAW_QUERY_TEMPLATES.includes(input.template as RawKnowledgeQueryTemplate)) {
    throw new RawKnowledgeQueryError("raw_query_template_invalid");
  }
  const template = input.template as RawKnowledgeQueryTemplate;
  const teamId = identifier(input.teamId, "team_id");
  const channelId = optionalIdentifier(input.channelId, "channel_id");
  const recordId = optionalIdentifier(input.recordId, "record_id");
  const sourceKey = optionalIdentifier(input.sourceKey, "source_key");
  const limit = input.limit === undefined ? 5 : input.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > RAW_QUERY_LIMITS.maxLimit) {
    throw new RawKnowledgeQueryError("raw_query_limit_invalid");
  }

  if (template === "recent_channel_memory" && !channelId) {
    throw new RawKnowledgeQueryError("channel_id_required");
  }
  if (template === "memory_record" && !recordId) {
    throw new RawKnowledgeQueryError("record_id_required");
  }
  if (template === "source_state" && !sourceKey) {
    throw new RawKnowledgeQueryError("source_key_required");
  }
  if (template !== "source_state" && sourceKey) {
    throw new RawKnowledgeQueryError("source_key_not_allowed");
  }
  if (template !== "memory_record" && recordId) {
    throw new RawKnowledgeQueryError("record_id_not_allowed");
  }
  return Object.freeze({
    schemaVersion: RAW_QUERY_SCHEMA_VERSION,
    template,
    teamId,
    ...(channelId ? { channelId } : {}),
    ...(recordId ? { recordId } : {}),
    ...(sourceKey ? { sourceKey } : {}),
    limit,
  });
}

export type RawKnowledgeMemoryRow = Readonly<{
  kind: "memory";
  id: string;
  teamId: string;
  channelId: string | null;
  title: string;
  body: string;
  updatedAt: string;
}>;

export type RawKnowledgeSourceStateRow = Readonly<{
  kind: "source_state";
  sourceKey: string;
  ledger: unknown;
  outbox: unknown;
}>;

export type RawKnowledgeQueryResponse = Readonly<{
  schemaVersion: typeof RAW_QUERY_SCHEMA_VERSION;
  template: RawKnowledgeQueryTemplate;
  rows: readonly (RawKnowledgeMemoryRow | RawKnowledgeSourceStateRow)[];
}>;
