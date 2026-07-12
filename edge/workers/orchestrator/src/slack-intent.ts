/**
 * Research-intent parsing, ported from the old Node bot's
 * `app/research-agent.ts`. Kept as a manual copy (not a shared import)
 * because the old bot depends on `@copilotkit/bot-slack`, which is not
 * available/desired in the Cloudflare Workers bundle. Behavior here MUST
 * stay in sync with the reference implementation at
 * `/Users/will/Documents/opentag/app/research-agent.ts`.
 */

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
