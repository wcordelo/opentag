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
function splitIntoSegments(text: string, maxChars: number): string[] {
  const segments: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= maxChars) {
      segments.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("\n", maxChars);
    if (cut <= 0) cut = maxChars;
    segments.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  return segments;
}

/**
 * Build Block Kit `section`/`mrkdwn` blocks for the given text, enforcing the
 * per-block char limit and the max-blocks-per-message limit. Overflow is
 * truncated with a trailing "…" rather than allowed to spill past the cap.
 */
export function buildMrkdwnBlocks(text: string): Array<{
  type: "section";
  text: { type: "mrkdwn"; text: string };
}> {
  const content = text.length > 0 ? text : "(empty)";
  const segments = splitIntoSegments(content, MAX_BLOCK_CHARS);
  const overflow = segments.length > MAX_BLOCKS_PER_MESSAGE;
  const kept = segments.slice(0, MAX_BLOCKS_PER_MESSAGE);
  const blocks = kept.map((seg) => ({
    type: "section" as const,
    text: { type: "mrkdwn" as const, text: seg },
  }));
  if (overflow && blocks.length > 0) {
    const last = blocks[blocks.length - 1]!;
    const suffix = "…";
    const room = Math.max(0, MAX_BLOCK_CHARS - suffix.length);
    last.text.text = last.text.text.slice(0, room) + suffix;
  }
  return blocks;
}

/** Truncate the `text` fallback field to Slack's 35k char limit. */
export function truncateFallbackText(text: string): string {
  const s = text.length > 0 ? text : "(empty)";
  if (s.length <= MAX_FALLBACK_CHARS) return s;
  return s.slice(0, MAX_FALLBACK_CHARS - 1) + "…";
}
