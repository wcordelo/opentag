import {
  classifyRouterMessage,
  type RouterClassification,
} from "../router/classifier.js";
import type { SlackNeutralEvent } from "./ingress-normalize.js";

type TurnSource = Extract<SlackNeutralEvent, { kind: "turn" }>["source"];

export type SlackResponseRoute = Readonly<{
  decision: "respond" | "observe";
  reason:
    | "direct_message"
    | "explicit_mention"
    | "trusted_trigger"
    | "file_share"
    | "question"
    | "action_request"
    | "problem_report"
    | "observe_conversation";
  classification: RouterClassification;
}>;

export type SlackThreadReplyRouteInput = Readonly<{
  userText: string;
  hasFiles: boolean;
}>;

const ACTION_REQUEST =
  /^(?:check|look(?:\s+at)?|review|tell|explain|investigate|confirm|find|fix|send|run|create|draft|update|summarize|recap|take\s+a\s+look)\b|\b(?:can|could|would)\s+you\b|\bhelp\s+me(?:\s+with|\s+to)?\b|\b(?:i|we)\s+(?:need|want)\s+you\s+to\b/i;
const PROBLEM_REPORT =
  /\b(?:delay|latency|slow(?:ness)?|stuck|blocked|error|broken|failed|failure|not\s+working|timeout|timed\s*out)\b|\b(?:can't|cannot|unable\s+to)\s+(?:access|connect|see|find|open|run|use|send|load|log\s*in|complete|finish|reply|reach|deploy|respond)\b/i;

function respond(
  reason: SlackResponseRoute["reason"],
  classification: RouterClassification,
): SlackResponseRoute {
  return Object.freeze({ decision: "respond", reason, classification });
}

export function classifySlackResponseRoute(input: {
  source: TurnSource;
  userText: string;
  hasFiles: boolean;
}): SlackResponseRoute {
  const classification = classifyRouterMessage({
    message: input.userText,
    hasAttachment: input.hasFiles,
  });
  if (input.source === "direct_message") {
    return respond("direct_message", classification);
  }
  if (input.source === "app_mention") {
    return respond("explicit_mention", classification);
  }
  if (input.source === "trusted_rich_mention") {
    return respond("trusted_trigger", classification);
  }
  if (input.hasFiles) return respond("file_share", classification);
  if (classification.primarySignal !== "conversational") {
    return respond(
      classification.primarySignal === "question_form"
        ? "question"
        : "action_request",
      classification,
    );
  }
  const routedText = classification.normalizedMessage;
  if (routedText.includes("?")) return respond("question", classification);
  if (ACTION_REQUEST.test(routedText)) {
    return respond("action_request", classification);
  }
  if (PROBLEM_REPORT.test(routedText)) {
    return respond("problem_report", classification);
  }
  return Object.freeze({
    decision: "observe",
    reason: "observe_conversation",
    classification,
  });
}

export function classifySlackThreadReplyRoute(
  input: SlackThreadReplyRouteInput,
): SlackResponseRoute {
  return classifySlackResponseRoute({
    source: "thread_reply",
    userText: input.userText,
    hasFiles: input.hasFiles,
  });
}
