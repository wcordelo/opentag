/**
 * Queue-consumer distillation + burst enrichment for Slack threads (K2 Phase 3).
 * Never called from Slack acknowledgement or ordinary turn paths.
 */

import {
  distillSlackThread,
  type DistillLlm,
  type SlackDistillArtifact,
} from "../distill/slack-distill.js";
import {
  selectBurstsForEmbed,
  type SlackBurstMessage,
} from "../distill/slack-bursts.js";
import { createIdfFn } from "../distill/idf.js";

export type SlackEnrichmentResult = {
  /** Primary text to embed for the thread-level Local document. */
  threadEmbedText: string;
  artifact?: SlackDistillArtifact;
  /** Extra burst documents to index alongside the thread. */
  burstDocuments: Array<{ embedText: string; authorId: string }>;
  reactionCount: number;
  distillStatus: "ok" | "skipped";
  distillReason?: string;
};

/**
 * Enrich a normalized Slack transcript before Local add.
 * On distill failure, indexes the raw transcript (fail closed to raw content).
 */
export async function enrichSlackThreadForIndex(input: {
  transcript: string;
  messages: SlackBurstMessage[];
  threadTopic: string;
  llm?: DistillLlm;
  documentFrequencies?: Map<string, number>;
  corpusSize?: number;
}): Promise<SlackEnrichmentResult> {
  const reactionCount = input.messages.reduce((total, message) => {
    const count = message.reactions ?? 0;
    return total + (Number.isSafeInteger(count) && count > 0 ? count : 0);
  }, 0);
  let threadEmbedText = input.transcript;
  let artifact: SlackDistillArtifact | undefined;
  let distillStatus: "ok" | "skipped" = "skipped";
  let distillReason: string | undefined = "llm_not_configured";

  if (input.llm) {
    const distilled = await distillSlackThread({
      transcript: input.transcript,
      llm: input.llm,
      timeoutMs: 8_000,
    });
    if (distilled.status === "ok") {
      threadEmbedText = distilled.embedText;
      artifact = distilled.artifact;
      distillStatus = "ok";
      distillReason = undefined;
    } else {
      threadEmbedText = distilled.embedText;
      distillStatus = "skipped";
      distillReason = distilled.reason;
    }
  }

  const idf = createIdfFn(
    input.documentFrequencies ?? new Map(),
    input.corpusSize ?? 1,
  );
  const bursts = selectBurstsForEmbed({
    messages: input.messages,
    threadTopic: input.threadTopic,
    corpusIdf: idf,
  });
  if (reactionCount > 0) {
    threadEmbedText = `${threadEmbedText}\nengagement reactions:${reactionCount}`;
  }

  return {
    threadEmbedText,
    ...(artifact ? { artifact } : {}),
    burstDocuments: bursts.map((b) => ({
      embedText: b.embedText,
      authorId: b.burst.authorId,
    })),
    reactionCount,
    distillStatus,
    ...(distillReason ? { distillReason } : {}),
  };
}
