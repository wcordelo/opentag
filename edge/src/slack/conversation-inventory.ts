import { SlackApiError, type SlackConversationSummary, type SlackWebClient } from "./web-api.js";

export const SLACK_CONVERSATION_INVENTORY_LIMITS = Object.freeze({
  pageSize: 200,
  maxPages: 50,
  maxVisibleConversations: 5_000,
});

export type SlackConversationInventoryLimits = {
  pageSize: number;
  maxPages: number;
  maxVisibleConversations: number;
};

export type SlackConversationInventoryKind = "channel" | "im" | "mpim" | "unknown";

export type SlackConversationInventoryExclusion = {
  conversationId: string;
  kind: SlackConversationInventoryKind;
  reason: "archived" | "bot_not_member" | "unsupported_conversation";
};

export type SlackConversationInventoryIncompleteReason =
  | "page_limit"
  | "conversation_limit"
  | "duplicate_conversation"
  | "api_error";

export type SlackConversationInventoryReceipt = {
  schemaVersion: 1;
  visibility: "installed_bot";
  status: "complete" | "incomplete";
  pages: number;
  visibleCount: number;
  eligibleCount: number;
  eligibleConversationIds: string[];
  excludedCount: number;
  excluded: SlackConversationInventoryExclusion[];
  excludedTruncated: boolean;
  incompleteReason?: SlackConversationInventoryIncompleteReason;
  errorCode?: string;
  inventoryDigest: string;
};

type InventoryWithoutDigest = Omit<SlackConversationInventoryReceipt, "inventoryDigest">;

function canonicalInventory(value: InventoryWithoutDigest): string {
  return JSON.stringify({
    schemaVersion: value.schemaVersion,
    visibility: value.visibility,
    status: value.status,
    pages: value.pages,
    visibleCount: value.visibleCount,
    eligibleCount: value.eligibleCount,
    eligibleConversationIds: [...value.eligibleConversationIds].sort(),
    excludedCount: value.excludedCount,
    excluded: [...value.excluded].sort((left, right) =>
      left.conversationId.localeCompare(right.conversationId) ||
      left.kind.localeCompare(right.kind) ||
      left.reason.localeCompare(right.reason)),
    excludedTruncated: value.excludedTruncated,
    ...(value.incompleteReason ? { incompleteReason: value.incompleteReason } : {}),
    ...(value.errorCode ? { errorCode: value.errorCode } : {}),
  });
}

export async function slackConversationInventoryDigest(
  receipt: SlackConversationInventoryReceipt | InventoryWithoutDigest,
): Promise<string> {
  const payload = { ...receipt } as Partial<SlackConversationInventoryReceipt>;
  delete payload.inventoryDigest;
  const bytes = new TextEncoder().encode(canonicalInventory(
    payload as InventoryWithoutDigest,
  ));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function inventoryKind(conversation: SlackConversationSummary): SlackConversationInventoryKind {
  if (conversation.isIm === true) return "im";
  if (conversation.isMpim === true) return "mpim";
  if (conversation.isPrivate === true || conversation.isIm === false || conversation.isMpim === false) {
    return "channel";
  }
  return "unknown";
}

function errorCode(error: unknown): string {
  const raw = error instanceof SlackApiError
    ? error.slackError
    : error instanceof Error
      ? error.message
      : "request_failed";
  const normalized = raw.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 128);
  return normalized || "request_failed";
}

async function finalizeInventory(
  value: InventoryWithoutDigest,
): Promise<SlackConversationInventoryReceipt> {
  const ordered: InventoryWithoutDigest = {
    ...value,
    eligibleConversationIds: [...value.eligibleConversationIds].sort(),
    excluded: [...value.excluded].sort((left, right) =>
      left.conversationId.localeCompare(right.conversationId) ||
      left.kind.localeCompare(right.kind) ||
      left.reason.localeCompare(right.reason)),
  };
  return {
    ...ordered,
    inventoryDigest: await slackConversationInventoryDigest(ordered),
  };
}

export async function enumerateSlackConversations(
  client: Pick<SlackWebClient, "listConversations">,
  limits: SlackConversationInventoryLimits = SLACK_CONVERSATION_INVENTORY_LIMITS,
): Promise<SlackConversationInventoryReceipt> {
  const eligible = new Set<string>();
  const excluded = new Map<string, SlackConversationInventoryExclusion>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  let visibleCount = 0;

  const base = (status: SlackConversationInventoryReceipt["status"]): InventoryWithoutDigest => ({
    schemaVersion: 1,
    visibility: "installed_bot",
    status,
    pages,
    visibleCount,
    eligibleCount: eligible.size,
    eligibleConversationIds: [...eligible],
    excludedCount: excluded.size,
    excluded: [...excluded.values()],
    excludedTruncated: false,
  });

  for (let page = 0; page < limits.maxPages; page += 1) {
    let result: Awaited<ReturnType<SlackWebClient["listConversations"]>>;
    try {
      result = await client.listConversations({
        pageSize: limits.pageSize,
        ...(cursor ? { cursor } : {}),
      });
    } catch (error) {
      return finalizeInventory({
        ...base("incomplete"),
        incompleteReason: "api_error",
        errorCode: errorCode(error),
      });
    }
    pages += 1;
    for (const conversation of result.conversations) {
      if (seen.has(conversation.id)) {
        return finalizeInventory({
          ...base("incomplete"),
          incompleteReason: "duplicate_conversation",
        });
      }
      seen.add(conversation.id);
      visibleCount += 1;
      if (visibleCount > limits.maxVisibleConversations) {
        return finalizeInventory({
          ...base("incomplete"),
          incompleteReason: "conversation_limit",
        });
      }
      const kind = inventoryKind(conversation);
      if (conversation.isArchived === true) {
        excluded.set(conversation.id, {
          conversationId: conversation.id,
          kind,
          reason: "archived",
        });
      } else if (conversation.isMember !== true) {
        excluded.set(conversation.id, {
          conversationId: conversation.id,
          kind,
          reason: "bot_not_member",
        });
      } else if (kind === "unknown") {
        excluded.set(conversation.id, {
          conversationId: conversation.id,
          kind,
          reason: "unsupported_conversation",
        });
      } else {
        eligible.add(conversation.id);
      }
    }
    const nextCursor = result.nextCursor;
    if (!nextCursor) return finalizeInventory(base("complete"));
    if (nextCursor === cursor) {
      return finalizeInventory({
        ...base("incomplete"),
        incompleteReason: "duplicate_conversation",
      });
    }
    cursor = nextCursor;
  }

  return finalizeInventory({
    ...base("incomplete"),
    incompleteReason: "page_limit",
  });
}
