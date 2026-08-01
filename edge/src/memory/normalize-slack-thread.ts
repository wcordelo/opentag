import type {
  IncompleteThread,
  KnowledgeThreadFetchOutcome,
  SkippedThread,
  SlackThreadMessage,
} from "../slack/knowledge-thread-fetcher.js";

export type SlackThreadNormalizationContext = {
  teamId: string;
  projectId: string;
  channelId: string;
  threadTs: string;
  aclPolicyRef: string;
};

export type CanonicalSlackMessage = {
  ts: string;
  authorId: string;
  kind: "message" | "deleted_marker" | "omitted_marker";
  text: string;
  blocksText?: string[];
  attachmentsText?: string[];
  files?: Array<{ name?: string; title?: string; mimetype?: string; filetype?: string; size?: number }>;
};

export type NormalizedSlackThread = {
  status: "complete";
  revision: `sha256:${string}`;
  content: string;
  canonical: {
    schemaVersion: 1;
    workspaceId: string;
    projectId: string;
    channelId: string;
    threadTs: string;
    aclPolicyRef: string;
    messages: CanonicalSlackMessage[];
  };
  bytes: number;
};

export type SlackThreadNormalizationOutcome =
  | NormalizedSlackThread
  | IncompleteThread
  | SkippedThread;

const encoder = new TextEncoder();
const ALLOWED_SUBTYPES = new Set(["", "file_share", "thread_broadcast"]);

export function normalizeStableWhitespace(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collectText(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (typeof value === "string") {
    const normalized = normalizeStableWhitespace(value);
    return normalized ? [normalized] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => collectText(item, depth + 1));
  if (typeof value !== "object") return [];
  const input = value as Record<string, unknown>;
  const output: string[] = [];
  // Only documented human-visible Slack fields are retained. IDs, colors,
  // callbacks, transport metadata, and private URLs are intentionally absent.
  for (const key of ["text", "title", "pretext", "fallback", "alt_text"]) {
    if (key in input) output.push(...collectText(input[key], depth + 1));
  }
  for (const key of ["fields", "elements", "accessory"]) {
    if (key in input) output.push(...collectText(input[key], depth + 1));
  }
  return output;
}

function canonicalFiles(value: unknown): CanonicalSlackMessage["files"] {
  if (!Array.isArray(value)) return undefined;
  const files = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const file = item as Record<string, unknown>;
    const output: NonNullable<CanonicalSlackMessage["files"]>[number] = {};
    for (const key of ["name", "title", "mimetype", "filetype"] as const) {
      if (typeof file[key] === "string") {
        const normalized = normalizeStableWhitespace(file[key] as string);
        if (normalized) output[key] = normalized;
      }
    }
    if (typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0) {
      output.size = file.size;
    }
    return Object.keys(output).length > 0 ? [output] : [];
  });
  files.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return files.length > 0 ? files : undefined;
}

function canonicalMessage(message: SlackThreadMessage): CanonicalSlackMessage {
  const ts = typeof message.ts === "string" ? message.ts : "";
  const subtype = typeof message.subtype === "string" ? message.subtype : "";
  if (subtype === "message_deleted" || message.hidden === true) {
    return { ts, authorId: "", kind: "deleted_marker", text: "[deleted message]" };
  }
  if (message.bot_id || subtype === "bot_message") {
    return { ts, authorId: "", kind: "omitted_marker", text: "[bot/system message omitted]" };
  }
  if (!ALLOWED_SUBTYPES.has(subtype)) {
    return {
      ts,
      authorId: typeof message.user === "string" ? message.user : "",
      kind: "omitted_marker",
      text: `[unsupported message omitted:${normalizeStableWhitespace(subtype) || "unknown"}]`,
    };
  }
  const blocksText = [...new Set(collectText(message.blocks))].sort();
  const attachmentsText = [...new Set(collectText(message.attachments))].sort();
  return {
    ts,
    authorId: typeof message.user === "string" ? message.user : "",
    kind: "message",
    text: normalizeStableWhitespace(typeof message.text === "string" ? message.text : ""),
    ...(blocksText.length > 0 ? { blocksText } : {}),
    ...(attachmentsText.length > 0 ? { attachmentsText } : {}),
    ...(canonicalFiles(message.files) ? { files: canonicalFiles(message.files) } : {}),
  };
}

function compareSlackTs(left: string, right: string): number {
  const [leftWhole = "", leftFraction = ""] = left.split(".", 2);
  const [rightWhole = "", rightFraction = ""] = right.split(".", 2);
  if (/^\d+$/.test(leftWhole) && /^\d+$/.test(rightWhole)) {
    if (leftWhole.length !== rightWhole.length) return leftWhole.length - rightWhole.length;
    const whole = leftWhole.localeCompare(rightWhole);
    if (whole !== 0) return whole;
    return leftFraction.padEnd(12, "0").localeCompare(rightFraction.padEnd(12, "0"));
  }
  return left.localeCompare(right);
}

function canonicalizeMessages(messages: SlackThreadMessage[]): CanonicalSlackMessage[] {
  const candidates = messages.map((message) => ({
    ts: typeof message.ts === "string" ? message.ts : "",
    clientId: typeof message.client_msg_id === "string" ? message.client_msg_id : "",
    message: canonicalMessage(message),
  }));
  candidates.sort((left, right) =>
    compareSlackTs(left.ts, right.ts) ||
    left.clientId.localeCompare(right.clientId) ||
    JSON.stringify(left.message).localeCompare(JSON.stringify(right.message))
  );
  const seenTimestamps = new Set<string>();
  const seenClientIds = new Set<string>();
  const output: CanonicalSlackMessage[] = [];
  for (const candidate of candidates) {
    if (
      (candidate.ts && seenTimestamps.has(candidate.ts)) ||
      (candidate.clientId && seenClientIds.has(candidate.clientId))
    ) continue;
    output.push(candidate.message);
    if (candidate.ts) seenTimestamps.add(candidate.ts);
    if (candidate.clientId) seenClientIds.add(candidate.clientId);
  }
  return output;
}

async function sha256(value: string): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Non-complete fetches are passed through and can never become complete writes. */
export async function normalizeSlackThread(
  fetched: KnowledgeThreadFetchOutcome,
  context: SlackThreadNormalizationContext,
): Promise<SlackThreadNormalizationOutcome> {
  if (fetched.status !== "complete") return fetched;
  const canonical = {
    schemaVersion: 1 as const,
    workspaceId: context.teamId,
    projectId: context.projectId,
    channelId: context.channelId,
    threadTs: context.threadTs,
    aclPolicyRef: context.aclPolicyRef,
    messages: canonicalizeMessages(fetched.messages),
  };
  const serialized = JSON.stringify(canonical);
  const content = canonical.messages.map((message) => {
    const additions = [message.text, ...(message.blocksText ?? []), ...(message.attachmentsText ?? [])]
      .filter(Boolean)
      .join("\n");
    return `[${message.ts || "unknown"}] ${message.authorId || "system"}: ${additions}`;
  }).join("\n");
  return {
    status: "complete",
    revision: await sha256(serialized),
    content,
    canonical,
    bytes: encoder.encode(serialized).byteLength,
  };
}
