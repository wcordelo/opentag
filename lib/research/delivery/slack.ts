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

  const form = new URLSearchParams({
    channel: parsed.channel,
    text: chunkMessage(text),
    mrkdwn: "true",
    client_msg_id: await stableSlackClientMessageId(obligationId),
  });
  if (threadTs) form.set("thread_ts", threadTs);

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
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let json: { ok?: unknown; error?: unknown };
  try {
    json = await res.json() as { ok?: unknown; error?: unknown };
  } catch (err) {
    return {
      status: "ambiguous",
      error: err instanceof Error ? err.message : "malformed_slack_response",
    };
  }
  if (json.ok === true) return { status: "delivered", duplicate: false };
  const error = typeof json.error === "string" ? json.error : "unknown_slack_error";
  if (error === "duplicate_message" || error === "duplicate_client_msg_id") {
    return { status: "delivered", duplicate: true };
  }
  if (json.ok === false) {
    console.error("[research-delivery] chat.postMessage failed", error);
    return { status: "definitive_failure", error };
  }
  return { status: "ambiguous", error };
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

function chunkMessage(text: string, maxLen = 3900): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n…(truncated)";
}
