import type { KnowledgeJob } from "./knowledge-contract.js";

export type KnowledgeQueueRoutingConfig = {
  KNOWLEDGE_QUEUE_NAME?: string;
  KNOWLEDGE_DLQ_NAME?: string;
};

export type KnowledgeQueueRoute = "primary" | "dlq";

const QUEUE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * Queue names are a C1 contract, not hints. The `-dlq` suffix is part of the
 * role binding so swapped environment values fail closed instead of silently
 * exchanging ingestion and terminal-failure handling.
 */
export function routeKnowledgeQueueName(
  deliveredQueueName: string,
  config: KnowledgeQueueRoutingConfig,
): KnowledgeQueueRoute {
  const primary = config.KNOWLEDGE_QUEUE_NAME;
  const dlq = config.KNOWLEDGE_DLQ_NAME;
  if (
    !primary ||
    !dlq ||
    !QUEUE_NAME.test(primary) ||
    !QUEUE_NAME.test(dlq) ||
    primary === dlq ||
    primary.endsWith("-dlq") ||
    !dlq.endsWith("-dlq")
  ) {
    throw new Error("knowledge_queue_names_missing_distinct_or_swapped");
  }
  if (deliveredQueueName === primary) return "primary";
  if (deliveredQueueName === dlq) return "dlq";
  throw new Error("knowledge_queue_name_unknown");
}

/**
 * Retry without decoding message bodies. Callers also throw so the platform
 * cannot interpret a routing configuration fault as successful consumption.
 */
export function retryKnowledgeBatchWithoutParsing(
  batch: MessageBatch<KnowledgeJob>,
  delaySeconds = 60,
): void {
  for (const message of batch.messages) {
    message.retry({ delaySeconds });
  }
}
