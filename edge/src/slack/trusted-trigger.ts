import type { RequestActor } from "../request-context.js";
import { extractRichDisplayText } from "./rich-display-text.js";

const BOT_ID_RE = /^B[A-Z0-9]{1,255}$/;
const APP_ID_RE = /^A[A-Z0-9]{1,255}$/;
const USER_ID_RE = /^[UW][A-Z0-9]{1,255}$/;

export type TrustedTriggerConfig = Readonly<{
  botUserId?: string;
  actors: ReadonlySet<string>;
  invalidActorCount?: number;
  botUserIdStatus?: "unset" | "invalid" | "valid";
  valid: boolean;
}>;

export type TrustedTriggerReadiness = Readonly<{
  ok: boolean;
  enabled: boolean;
  actorCount: number;
  invalidActorCount: number;
  reason: "disabled" | "ready" | "missing_target_id" | "invalid_config";
}>;

export type TrustedRichTrigger = Readonly<{
  actor: Extract<RequestActor, { kind: "slack_automation" }>;
  displayText: string;
}>;

export type TrustedRichTriggerDecision = Readonly<{
  trigger?: TrustedRichTrigger;
  reason?:
    | "not_allowlisted"
    | "missing_target_id"
    | "no_rich_mention"
    | "own_bot"
    | "invalid_config";
}>;

export function parseTrustedTriggerConfig(
  botUserId: string | undefined,
  rawActors: string | undefined,
): TrustedTriggerConfig {
  const actors = new Set<string>();
  let invalidActorCount = 0;
  for (const token of rawActors?.split(/[\s,]+/) ?? []) {
    if (!token) continue;
    const [kind, id, extra] = token.split(":");
    if (
      !extra &&
      ((kind === "bot" && BOT_ID_RE.test(id ?? "")) ||
        (kind === "app" && APP_ID_RE.test(id ?? "")))
    ) {
      actors.add(`${kind}:${id}`);
    } else {
      invalidActorCount += 1;
    }
  }
  const normalizedBotUserId = botUserId?.trim();
  const botUserIdStatus =
    !normalizedBotUserId
      ? ("unset" as const)
      : USER_ID_RE.test(normalizedBotUserId)
        ? ("valid" as const)
        : ("invalid" as const);
  const valid =
    invalidActorCount === 0 || actors.size > 0
      ? actors.size === 0 || botUserIdStatus === "valid"
      : false;
  return Object.freeze({
    ...(botUserIdStatus === "valid"
      ? { botUserId: normalizedBotUserId }
      : {}),
    actors,
    invalidActorCount,
    botUserIdStatus,
    valid,
  });
}

export function trustedTriggerReadiness(
  config: TrustedTriggerConfig,
): TrustedTriggerReadiness {
  const invalidActorCount = config.invalidActorCount ?? 0;
  const botUserIdStatus =
    config.botUserIdStatus ?? (config.botUserId ? "valid" : "unset");
  if (invalidActorCount > 0 && config.actors.size === 0) {
    return Object.freeze({
      ok: false,
      enabled: false,
      actorCount: 0,
      invalidActorCount,
      reason: "invalid_config",
    });
  }
  if (config.actors.size === 0) {
    return Object.freeze({
      ok: true,
      enabled: false,
      actorCount: 0,
      invalidActorCount,
      reason: "disabled",
    });
  }
  if (botUserIdStatus === "unset") {
    return Object.freeze({
      ok: false,
      enabled: false,
      actorCount: config.actors.size,
      invalidActorCount,
      reason: "missing_target_id",
    });
  }
  if (botUserIdStatus === "invalid") {
    return Object.freeze({
      ok: false,
      enabled: false,
      actorCount: config.actors.size,
      invalidActorCount,
      reason: "invalid_config",
    });
  }
  return Object.freeze({
    ok: true,
    enabled: true,
    actorCount: config.actors.size,
    invalidActorCount,
    reason: "ready",
  });
}

export function classifyTrustedRichTrigger(
  event: unknown,
  config: TrustedTriggerConfig,
): TrustedRichTrigger | undefined {
  return trustedRichTriggerDecision(event, config).trigger;
}

export function trustedRichTriggerDecision(
  event: unknown,
  config: TrustedTriggerConfig,
): TrustedRichTriggerDecision {
  if (
    !event ||
    typeof event !== "object"
  ) return Object.freeze({});
  const record = event as Record<string, unknown>;
  if (record.type !== "message") return Object.freeze({});
  if (
    record.subtype &&
    record.subtype !== "bot_message"
  ) return Object.freeze({});
  const botCandidate = Boolean(
    record.bot_id ||
    record.app_id ||
    record.bot_profile,
  );
  if (!botCandidate) return Object.freeze({});
  const readiness = trustedTriggerReadiness(config);
  if (readiness.reason === "missing_target_id") {
    return Object.freeze({ reason: "missing_target_id" });
  }
  if (!readiness.ok) return Object.freeze({ reason: "invalid_config" });
  if (!readiness.enabled || !config.botUserId) {
    return Object.freeze({ reason: "not_allowlisted" });
  }
  const botProfile =
    record.bot_profile && typeof record.bot_profile === "object"
      ? (record.bot_profile as Record<string, unknown>)
      : undefined;
  if (
    record.user === config.botUserId ||
    botProfile?.user_id === config.botUserId
  ) return Object.freeze({ reason: "own_bot" });
  const botId =
    typeof record.bot_id === "string"
      ? record.bot_id
      : typeof botProfile?.id === "string"
        ? botProfile.id
        : undefined;
  const appId =
    typeof record.app_id === "string"
      ? record.app_id
      : typeof botProfile?.app_id === "string"
        ? botProfile.app_id
        : undefined;
  const matchedBot = botId && config.actors.has(`bot:${botId}`);
  const matchedApp = appId && config.actors.has(`app:${appId}`);
  if (!matchedBot && !matchedApp) {
    return Object.freeze({ reason: "not_allowlisted" });
  }
  const rich = extractRichDisplayText(record, config.botUserId);
  if (!rich.hasMention || !rich.displayText) {
    return Object.freeze({ reason: "no_rich_mention" });
  }
  return Object.freeze({
    trigger: Object.freeze({
      actor: Object.freeze({
        kind: "slack_automation",
        ...(matchedBot && botId ? { botId } : {}),
        ...(matchedApp && appId ? { appId } : {}),
        ...(typeof botProfile?.name === "string"
          ? { displayName: botProfile.name.slice(0, 256) }
          : {}),
      }),
      displayText: rich.displayText,
    }),
  });
}
