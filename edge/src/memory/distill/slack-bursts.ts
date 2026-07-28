/** Coalesce consecutive same-author Slack messages into embeddable bursts. */

import { maxTokenIdf, tokenize } from "./idf.js";

export type SlackBurstMessage = {
  authorId: string;
  text: string;
  reactions?: number;
};

export type SlackBurst = {
  authorId: string;
  messages: SlackBurstMessage[];
  text: string;
};

const DEFAULT_MIN_CHARS = 200;
const DEFAULT_MIN_IDF = 4.0;

/** Group consecutive messages from the same author into bursts. */
export function groupBursts(messages: SlackBurstMessage[]): SlackBurst[] {
  const bursts: SlackBurst[] = [];
  for (const message of messages) {
    const last = bursts[bursts.length - 1];
    if (last && last.authorId === message.authorId) {
      last.messages.push(message);
      last.text = last.messages.map((item) => item.text).filter(Boolean).join("\n");
      continue;
    }
    bursts.push({
      authorId: message.authorId,
      messages: [message],
      text: message.text ?? "",
    });
  }
  return bursts;
}

/** Score a burst by the sum of unique-token IDFs (plus a small reaction boost). */
export function scoreBurst(burst: SlackBurst, corpusIdf: (token: string) => number): number {
  const seen = new Set<string>();
  let score = 0;
  for (const token of tokenize(burst.text)) {
    if (seen.has(token)) continue;
    seen.add(token);
    score += corpusIdf(token);
  }
  const reactions = totalReactions(burst);
  if (reactions > 0) score += Math.log1p(reactions);
  return score;
}

function totalReactions(burst: SlackBurst): number {
  let total = 0;
  for (const message of burst.messages) {
    const count = message.reactions ?? 0;
    if (Number.isFinite(count) && count > 0) total += count;
  }
  return total;
}

/**
 * Select bursts worth embedding.
 *
 * Cerebras-style criteria (length / IDF / reactions) implemented as:
 * `(length >= minChars && maxIdf >= minIdf) || reactions > 0`
 *
 * When `requireReaction` is true, the same rule applies (reactions OR length+idf).
 * `embedText` is `threadTopic` + burst text.
 */
export function selectBurstsForEmbed(input: {
  messages: SlackBurstMessage[];
  threadTopic: string;
  corpusIdf: (token: string) => number;
  minChars?: number;
  minIdf?: number;
  requireReaction?: boolean;
}): Array<{ burst: SlackBurst; embedText: string }> {
  const minChars = input.minChars ?? DEFAULT_MIN_CHARS;
  const minIdf = input.minIdf ?? DEFAULT_MIN_IDF;
  const requireReaction = input.requireReaction ?? false;
  const topic = input.threadTopic.trim();
  const selected: Array<{ burst: SlackBurst; embedText: string }> = [];

  for (const burst of groupBursts(input.messages)) {
    const length = burst.text.length;
    const maxIdf = maxTokenIdf(burst.text, input.corpusIdf);
    const reactions = totalReactions(burst);
    const lengthIdfOk = length >= minChars && maxIdf >= minIdf;
    const reactionOk = reactions > 0;
    // Default and requireReaction both allow reaction OR length+idf.
    // requireReaction documents that reaction alone is an accepted path.
    const ok = requireReaction ? reactionOk || lengthIdfOk : lengthIdfOk || reactionOk;
    if (!ok) continue;
    const embedText = [topic, burst.text].filter(Boolean).join("\n");
    selected.push({ burst, embedText });
  }
  return selected;
}
