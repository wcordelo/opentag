/** Post research delivery obligations to Slack via Web API. */

export interface SlackDeliveryPayload {
  type: "interim" | "final" | "error";
  text: string;
  taskId: string;
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
  botToken?: string,
): Promise<boolean> {
  const token = botToken ?? process.env["SLACK_BOT_TOKEN"];
  if (!token) return false;

  const parsed = parseThreadKey(threadKey);
  if (!parsed) return false;

  // Only real Slack timestamps belong in thread_ts (not slash:: scopes).
  const threadTs =
    parsed.threadTs &&
    parsed.threadTs !== parsed.channel &&
    /^\d+\.\d+$/.test(parsed.threadTs)
      ? parsed.threadTs
      : undefined;

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      channel: parsed.channel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: chunkMessage(text),
      mrkdwn: true,
    }),
  });

  const json = (await res.json()) as { ok: boolean; error?: string };
  if (!json.ok) {
    console.error("[research-delivery] chat.postMessage failed", json.error);
  }
  return json.ok;
}

function chunkMessage(text: string, maxLen = 3900): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n…(truncated)";
}
