/**
 * Research agent client — separate AG-UI endpoint from triage runtime.
 */
import { SanitizingHttpAgent } from "@copilotkit/bot-slack";

export function createResearchAgent(threadId: string) {
  const url =
    process.env["AGENT_RESEARCH_URL"] ??
    "http://localhost:8201/api/copilotkit/agent/research/run";
  const headers = process.env["AGENT_AUTH_HEADER"]
    ? { Authorization: process.env["AGENT_AUTH_HEADER"] }
    : undefined;

  const agent = new SanitizingHttpAgent({ url, headers });
  agent.threadId = threadId;
  return agent;
}

export function isResearchIntent(text: string): boolean {
  return /^\s*research\b/i.test(text) || /\bresearch:\s*/i.test(text);
}

export function extractResearchObjective(text: string): string {
  return text
    .replace(/<@[^>]+>/g, "")
    .replace(/^\s*research[:\s]+/i, "")
    .trim();
}

export function buildThreadKey(
  platform: string,
  channelId: string,
  threadTs: string,
): string {
  return `${platform}:${channelId}:${threadTs}`;
}

const deliveryApiBase =
  process.env["RESEARCH_DELIVERY_URL"] ?? "http://localhost:8202";

export interface DeliveryObligation {
  id: string;
  threadKey: string;
  payload: {
    type: "interim" | "final" | "error";
    text: string;
    taskId: string;
  };
  status: string;
}

export async function pollDeliveries(
  threadKey?: string,
): Promise<DeliveryObligation[]> {
  const url = threadKey
    ? `${deliveryApiBase}/api/research/deliveries?threadKey=${encodeURIComponent(threadKey)}`
    : `${deliveryApiBase}/api/research/deliveries`;
  const res = await fetch(url);
  if (!res.ok) return [];
  return (await res.json()) as DeliveryObligation[];
}

export async function markDeliveryDelivered(id: string): Promise<void> {
  await fetch(`${deliveryApiBase}/api/research/deliveries/${id}`, {
    method: "POST",
  });
}
