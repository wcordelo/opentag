/** Post research delivery obligations to Slack via Web API. */

export interface SlackDeliveryPayload {
  type: "interim" | "final" | "error";
  text: string;
  taskId: string;
}

export type SlackDeliveryOutcome =
  | { status: "delivered"; duplicate: boolean }
  | { status: "definitive_failure"; error: string }
  | { status: "ambiguous"; error: string };

const SLACK_BLOCK_TEXT_MAX = 3_000;
const SLACK_MESSAGE_BLOCKS_MAX = 50;
const SLACK_FALLBACK_TEXT_MAX = 35_000;

interface SlackDeliveryPage {
  text: string;
  blocks?: unknown[];
}

function researchResultBlocks(
  text: string,
  payload: SlackDeliveryPayload,
  includeActions: boolean,
): unknown[] {
  const sections: unknown[] = [];
  for (const chunk of splitSlackText(text, SLACK_BLOCK_TEXT_MAX)) {
    if (!chunk) continue;
    sections.push({
      type: "section",
      text: { type: "mrkdwn", text: chunk },
    });
  }

  if (includeActions) {
    const value = JSON.stringify({ type: "research", taskId: payload.taskId });
    sections.push({
      type: "actions",
      elements: [
        { type: "button", action_id: "quick_retry", text: { type: "plain_text", text: "Retry" }, value },
        { type: "button", action_id: "quick_dig_deeper", text: { type: "plain_text", text: "Dig deeper" }, value },
        { type: "button", action_id: "quick_export", text: { type: "plain_text", text: "Export" }, value },
      ],
    });
  }

  if (sections.length > SLACK_MESSAGE_BLOCKS_MAX) {
    throw new Error("research delivery page exceeds Slack block limit");
  }
  return sections;
}

/**
 * Build lossless Slack-safe pages. The fallback text and mrkdwn sections both
 * reconstruct the original result; action cards appear only after all content.
 */
export function researchDeliveryPages(payload: SlackDeliveryPayload): SlackDeliveryPage[] {
  const pageTexts = splitSlackText(payload.text, SLACK_FALLBACK_TEXT_MAX);
  return pageTexts.map((text, index) => ({
    text,
    blocks: payload.type === "final"
      ? researchResultBlocks(text, payload, index === pageTexts.length - 1)
      : undefined,
  }));
}

export function parseThreadKey(threadKey: string): {
  channel: string;
  threadTs: string;
} | null {
  // Format: slack:C123:1234567890.123456
  const parts = threadKey.split(":");
  if (parts.length < 3 || parts[0] !== "slack") return null;
  return { channel: parts[1]!, threadTs: parts.slice(2).join(":") };
}

export async function postToSlackThread(
  threadKey: string,
  text: string,
  obligationId: string,
  botToken?: string,
  delivery?: SlackDeliveryPayload,
): Promise<SlackDeliveryOutcome> {
  const token = botToken ?? process.env["SLACK_BOT_TOKEN"];
  if (!token) return { status: "definitive_failure", error: "missing_bot_token" };

  const parsed = parseThreadKey(threadKey);
  if (!parsed) return { status: "definitive_failure", error: "invalid_thread_key" };

  // Only real Slack timestamps belong in thread_ts (not slash:: scopes).
  const threadTs =
    parsed.threadTs &&
    parsed.threadTs !== parsed.channel &&
    /^\d+\.\d+$/.test(parsed.threadTs)
      ? parsed.threadTs
      : undefined;

  const canonicalPayload = delivery ?? {
    type: "interim" as const,
    text,
    taskId: obligationId,
  };
  const pages = researchDeliveryPages(canonicalPayload);
  let duplicate = false;

  // Pages are deliberately posted in order. If page N is ambiguous, the
  // durable obligation stays in flight; replay starts at page 1, where Slack
  // de-duplicates already accepted page IDs before retrying page N.
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]!;
    const pageIdentity = `${obligationId}:slack-pages-v2:${index + 1}`;
    const form = new URLSearchParams({
      channel: parsed.channel,
      text: page.text,
      mrkdwn: "true",
      client_msg_id: await stableSlackClientMessageId(pageIdentity),
    });
    if (threadTs) form.set("thread_ts", threadTs);
    if (page.blocks) form.set("blocks", JSON.stringify(page.blocks));

    let res: Response;
    try {
      res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          Authorization: `Bearer ${token}`,
        },
        body: form.toString(),
      });
    } catch (err) {
      return {
        status: "ambiguous",
        error: pageError(index, pages.length, err instanceof Error ? err.message : String(err)),
      };
    }

    let json: { ok?: unknown; error?: unknown };
    try {
      json = await res.json() as { ok?: unknown; error?: unknown };
    } catch (err) {
      return {
        status: "ambiguous",
        error: pageError(
          index,
          pages.length,
          err instanceof Error ? err.message : "malformed_slack_response",
        ),
      };
    }
    if (json.ok === true) continue;
    const error = typeof json.error === "string" ? json.error : "unknown_slack_error";
    if (error === "duplicate_message" || error === "duplicate_client_msg_id") {
      duplicate = true;
      continue;
    }
    if (json.ok === false) {
      console.error("[research-delivery] chat.postMessage failed", error);
      return { status: "definitive_failure", error: pageError(index, pages.length, error) };
    }
    return { status: "ambiguous", error: pageError(index, pages.length, error) };
  }

  return { status: "delivered", duplicate };
}

async function stableSlackClientMessageId(input: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  ).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function splitSlackText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + maxLen, text.length);
    if (
      end < text.length &&
      text.charCodeAt(end - 1) >= 0xd800 &&
      text.charCodeAt(end - 1) <= 0xdbff &&
      text.charCodeAt(end) >= 0xdc00 &&
      text.charCodeAt(end) <= 0xdfff
    ) {
      end--;
    }
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

function pageError(index: number, total: number, error: string): string {
  return `page_${index + 1}_of_${total}:${error}`;
}
