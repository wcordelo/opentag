export const SLACK_INSTALLATION_SCHEMA_VERSION = 1 as const;

export const SLACK_REQUIRED_BOT_SCOPES = Object.freeze([
  "app_mentions:read",
  "assistant:write",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
  "users:read",
  "users:read.email",
  "users.profile:read",
  "team:read",
  "reactions:read",
  "chat:write",
  "chat:write.public",
  "chat:write.customize",
  "reactions:write",
  "im:write",
  "mpim:write",
  "files:read",
  "files:write",
  "channels:join",
  "commands",
] as const);

export const SLACK_REQUIRED_BOT_EVENTS = Object.freeze([
  "app_mention",
  "assistant_thread_started",
  "assistant_thread_context_changed",
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
  "reaction_added",
  "reaction_removed",
  "member_joined_channel",
  "member_left_channel",
  "app_uninstalled",
  "tokens_revoked",
  "channel_archive",
  "channel_unarchive",
  "channel_deleted",
  "channel_left",
  "channel_unshared",
  "group_archive",
  "group_unarchive",
  "group_deleted",
  "group_close",
  "group_open",
  "group_left",
] as const);

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class SlackInstallationContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SlackInstallationContractError";
  }
}

export type SlackManifestReadback = Readonly<{
  schemaVersion: typeof SLACK_INSTALLATION_SCHEMA_VERSION;
  teamId: string;
  botUserId: string;
  botScopes: readonly string[];
  botEvents: readonly string[];
  observedAt: string;
}>;

export type SlackManifestCoverage = Readonly<{
  status: "complete" | "incomplete";
  missingScopes: readonly string[];
  missingEvents: readonly string[];
}>;

export type SlackManifestCoverageReceipt = SlackManifestReadback & SlackManifestCoverage & Readonly<{
  manifestDigest: string;
}>;

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SlackInstallationContractError(code);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    CONTROL_RE.test(value)
  ) {
    throw new SlackInstallationContractError(`${field}_invalid`);
  }
  return value;
}

function identifier(value: unknown, field: string): string {
  const result = text(value, field, 64);
  if (!/^[A-Z][A-Z0-9]+$/.test(result)) {
    throw new SlackInstallationContractError(`${field}_invalid`);
  }
  return result;
}

function timestamp(value: unknown): string {
  const result = text(value, "observed_at", 32);
  if (!ISO_RE.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new SlackInstallationContractError("observed_at_invalid");
  }
  return result;
}

function stringList(value: unknown, field: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new SlackInstallationContractError(`${field}_invalid`);
  }
  const values = value.map((item) => text(item, field, 128));
  if (new Set(values).size !== values.length) {
    throw new SlackInstallationContractError(`${field}_duplicate`);
  }
  return [...values].sort();
}

function canonicalReadback(value: SlackManifestReadback): string {
  return JSON.stringify({
    schemaVersion: value.schemaVersion,
    teamId: value.teamId,
    botUserId: value.botUserId,
    botScopes: [...value.botScopes].sort(),
    botEvents: [...value.botEvents].sort(),
  });
}

function missing(required: readonly string[], actual: readonly string[]): string[] {
  const present = new Set(actual);
  return required.filter((item) => !present.has(item));
}

export function validateSlackManifestReadback(value: unknown): SlackManifestReadback {
  const input = record(value, "slack_manifest_readback_invalid");
  const allowed = new Set([
    "schemaVersion",
    "teamId",
    "botUserId",
    "botScopes",
    "botEvents",
    "observedAt",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new SlackInstallationContractError("slack_manifest_readback_field_invalid");
  }
  if (input.schemaVersion !== SLACK_INSTALLATION_SCHEMA_VERSION) {
    throw new SlackInstallationContractError("slack_manifest_schema_invalid");
  }
  return Object.freeze({
    schemaVersion: SLACK_INSTALLATION_SCHEMA_VERSION,
    teamId: identifier(input.teamId, "team_id"),
    botUserId: identifier(input.botUserId, "bot_user_id"),
    botScopes: Object.freeze(stringList(input.botScopes, "bot_scopes", 128)),
    botEvents: Object.freeze(stringList(input.botEvents, "bot_events", 128)),
    observedAt: timestamp(input.observedAt),
  });
}

export function extractSlackManifestCapabilities(value: unknown): Pick<SlackManifestReadback, "botScopes" | "botEvents"> {
  const input = record(value, "slack_manifest_invalid");
  const oauth = record(input.oauth_config, "slack_manifest_oauth_invalid");
  const scopes = record(oauth.scopes, "slack_manifest_scopes_invalid");
  const settings = record(input.settings, "slack_manifest_settings_invalid");
  const events = record(settings.event_subscriptions, "slack_manifest_events_invalid");
  return Object.freeze({
    botScopes: Object.freeze(stringList(scopes.bot, "bot_scopes", 128)),
    botEvents: Object.freeze(stringList(events.bot_events, "bot_events", 128)),
  });
}

export function assessSlackManifestCoverage(
  value: SlackManifestReadback,
): SlackManifestCoverage {
  const readback = validateSlackManifestReadback(value);
  const missingScopes = missing(SLACK_REQUIRED_BOT_SCOPES, readback.botScopes);
  const missingEvents = missing(SLACK_REQUIRED_BOT_EVENTS, readback.botEvents);
  return Object.freeze({
    status: missingScopes.length === 0 && missingEvents.length === 0
      ? "complete"
      : "incomplete",
    missingScopes: Object.freeze(missingScopes),
    missingEvents: Object.freeze(missingEvents),
  });
}

export async function slackManifestCoverageReceipt(
  value: unknown,
): Promise<SlackManifestCoverageReceipt> {
  const readback = validateSlackManifestReadback(value);
  const coverage = assessSlackManifestCoverage(readback);
  const digestBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalReadback(readback)),
  );
  const manifestDigest = `sha256:${[...new Uint8Array(digestBytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
  return Object.freeze({
    ...readback,
    ...coverage,
    manifestDigest,
  });
}
