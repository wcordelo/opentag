/**
 * Multi-source knowledge identity helpers (K2 Phase 1).
 *
 * Validation matches `slackSourceKey` in knowledge-contract.ts: team/scope
 * segments reject `:` and control chars; the final document id segment allows
 * dots (and other non-control chars) like Slack thread timestamps.
 */

const MAX_IDENTIFIER_LENGTH = 128;

export type KnowledgeSourceType = "slack" | "wiki" | "code" | "custom_db";

const SOURCE_TYPES: readonly KnowledgeSourceType[] = [
  "slack",
  "wiki",
  "code",
  "custom_db",
];

function identifier(value: string, field: string): string {
  if (
    !value ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    /[:\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${field} must be a non-empty safe identifier`);
  }
  return value;
}

function sourcePart(value: string, field: string): string {
  if (
    !value ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${field} must be a non-empty safe source component`);
  }
  return value;
}

export function parseKnowledgeSourceType(value: unknown): KnowledgeSourceType {
  if (typeof value !== "string" || !SOURCE_TYPES.includes(value as KnowledgeSourceType)) {
    throw new Error("sourceType must be slack, wiki, code, or custom_db");
  }
  return value as KnowledgeSourceType;
}

/** `wiki:{teamId}:{spaceId}:{pageId}` */
export function wikiSourceKey(teamId: string, spaceId: string, pageId: string): string {
  return `wiki:${identifier(teamId, "teamId")}:${identifier(spaceId, "spaceId")}:${sourcePart(pageId, "pageId")}`;
}

/** `code:{teamId}:{repoId}:{chunkId}` */
export function codeSourceKey(teamId: string, repoId: string, chunkId: string): string {
  return `code:${identifier(teamId, "teamId")}:${identifier(repoId, "repoId")}:${sourcePart(chunkId, "chunkId")}`;
}

/** `custom_db:{teamId}:{connectorId}:{rowId}` */
export function customDbSourceKey(
  teamId: string,
  connectorId: string,
  rowId: string,
): string {
  return `custom_db:${identifier(teamId, "teamId")}:${identifier(connectorId, "connectorId")}:${sourcePart(rowId, "rowId")}`;
}

/**
 * Derive sourceType from a stable sourceKey prefix.
 * Recognizes `slack:…`, `wiki:…`, `code:…`, and `custom_db:…`.
 */
export function parseSourceTypeFromKey(sourceKey: string): KnowledgeSourceType {
  if (typeof sourceKey !== "string" || sourceKey.length === 0) {
    throw new Error("sourceKey must be a non-empty string");
  }
  if (sourceKey.startsWith("custom_db:")) return "custom_db";
  const colon = sourceKey.indexOf(":");
  if (colon <= 0) throw new Error("sourceKey is missing a sourceType prefix");
  const prefix = sourceKey.slice(0, colon);
  return parseKnowledgeSourceType(prefix);
}
