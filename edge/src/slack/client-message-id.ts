import { makeWireIdSync } from "../harness/wire-id.js";

/**
 * Slack requires `client_msg_id` to be UUID-shaped. Derive it synchronously
 * from immutable turn identity so ingress can reserve it before its first
 * await and every ambiguous retry/recovery path addresses the same message.
 */
export function stableSlackClientMessageId(input: string): string {
  const wire = makeWireIdSync("execution", "slack-client-message", [input]);
  const encoded = wire.slice(wire.indexOf("_") + 1);
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - encoded.length % 4) % 4);
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary.slice(0, 16), (character) => character.charCodeAt(0));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Canonical identity for lossless answer pages after the reserved live page 0.
 * Normal AG-UI/stream delivery and alarm recovery must call this exact helper
 * with the same execution id and zero-based page index.
 */
export function stableSlackPageClientMessageId(
  executionId: string,
  pageIndex: number,
): string {
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new Error("slack_continuation_page_index_must_be_nonnegative");
  }
  return stableSlackClientMessageId(
    `${executionId}:canonical-output-page:${pageIndex}`,
  );
}

/** Recovery-only diagnostics intentionally cannot collide with answer pages. */
export function stableSlackDiagnosticPageClientMessageId(
  executionId: string,
  pageIndex: number,
): string {
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new Error("slack_diagnostic_page_index_must_be_nonnegative");
  }
  return stableSlackClientMessageId(
    `${executionId}:recovery-diagnostic-page:${pageIndex}`,
  );
}
