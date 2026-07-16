/**
 * Helpers for incremental Slack rendering (see `cloudflare-slack-adapter.ts`
 * `stream()`). Kept separate so the block-splitting / truncation logic can be
 * unit tested without spinning up the whole adapter.
 *
 * Slack limits enforced here (house rules, learned the hard way in centaur):
 *   - `section` blocks: 3,000 chars of mrkdwn each
 *   - 50 blocks max per message
 *   - `text` fallback field: 35,000 chars max
 */
import type { ChatSDKStreamChunk } from "./chunk-types.js";

export const MAX_BLOCK_CHARS = 3000;
export const MAX_BLOCKS_PER_MESSAGE = 50;
export const MAX_FALLBACK_CHARS = 35000;

/** Wrap a plain string stream (the `PlatformAdapter.stream()` input) as markdown chunks so it can be piped through `conflateChatSdkStream`. */
export function stringsToMarkdownChunks(
  source: AsyncIterable<string>,
): AsyncIterable<ChatSDKStreamChunk> {
  return (async function* () {
    for await (const text of source) {
      yield { type: "markdown_text", text } satisfies ChatSDKStreamChunk;
    }
  })();
}

/** Split text into <= maxChars segments, preferring newline boundaries. */
export function splitIntoSegments(text: string, maxChars: number): string[] {
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new RangeError("maxChars must be a positive integer");
  }
  const segments: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= maxChars) {
      segments.push(rest);
      break;
    }
    // Include the preferred boundary newline in the preceding segment. This
    // keeps segmentation byte-for-byte lossless while guaranteeing that even
    // a newline at index zero makes progress.
    const newline = rest.lastIndexOf("\n", maxChars - 1);
    const cut = newline >= 0 ? newline + 1 : maxChars;
    segments.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return segments;
}

/**
 * Build one Slack-safe page of Block Kit `section`/`mrkdwn` blocks. Callers
 * rendering complete output must use {@link buildSlackMessagePages}; this
 * compatibility helper intentionally returns only page one so an individual
 * request can never violate Slack's 50-block ceiling.
 */
export function buildMrkdwnBlocks(text: string): Array<{
  type: "section";
  text: { type: "mrkdwn"; text: string };
}> {
  const content = text.length > 0 ? text : "(empty)";
  const segments = splitIntoSegments(content, MAX_BLOCK_CHARS);
  const kept = segments.slice(0, MAX_BLOCKS_PER_MESSAGE);
  return kept.map((seg) => ({
    type: "section" as const,
    text: { type: "mrkdwn" as const, text: seg },
  }));
}

export interface SlackMessagePage {
  /** Zero-based, stable page number used to derive continuation identities. */
  index: number;
  /** Human-readable fallback field, independently bounded to 35k chars. */
  text: string;
  blocks: Array<{
    type: "section";
    text: { type: "mrkdwn"; text: string };
  }>;
}

/**
 * Losslessly page arbitrary markdown into Slack-valid messages. Each page is
 * independently bounded to 50 blocks and each block to 3,000 characters.
 * Page indices are deterministic, allowing callers to derive stable
 * `client_msg_id`s and resume at the first unconfirmed continuation.
 */
export function buildSlackMessagePages(text: string): SlackMessagePage[] {
  const content = text.length > 0 ? text : "(empty)";
  const segments = splitIntoSegments(content, MAX_BLOCK_CHARS);
  const pages: SlackMessagePage[] = [];
  for (let offset = 0; offset < segments.length; offset += MAX_BLOCKS_PER_MESSAGE) {
    const pageSegments = segments.slice(offset, offset + MAX_BLOCKS_PER_MESSAGE);
    pages.push({
      index: pages.length,
      text: truncateFallbackText(pageSegments.join("")),
      blocks: pageSegments.map((segment) => ({
        type: "section",
        text: { type: "mrkdwn", text: segment },
      })),
    });
  }
  return pages;
}

/** Truncate the `text` fallback field to Slack's 35k char limit. */
export function truncateFallbackText(text: string): string {
  const s = text.length > 0 ? text : "(empty)";
  if (s.length <= MAX_FALLBACK_CHARS) return s;
  return s.slice(0, MAX_FALLBACK_CHARS - 1) + "…";
}
