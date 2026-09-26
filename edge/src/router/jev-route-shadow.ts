/**
 * TypeSafe Jev shadow judgments for Slack respond/observe routing (P2).
 * One SystemOne request per message; fail open on any error.
 */

import {
  buildRouterJevRouteQuestions,
  buildRouterJevRouteState,
  type RouterJevRouteSource,
  type RouterJevRouteState,
} from "./jev-route-questions.js";

export const TYPESAFE_API_URL = "https://api.typesafe.ai/v1/systemone";

export type RouterJevRouteChoiceAnswer = Readonly<{
  choice: "respond" | "observe";
  probabilities: Readonly<Record<string, number>>;
  confidence?: number;
}>;

export type RouterJevNoulAnswer = Readonly<{
  noul: number;
  overriddenByOptOut?: boolean;
}>;

export type RouterJevRouteJudgment = Readonly<{
  schema: 1;
  shadow: true;
  model: string;
  latencyMs: number;
  state: RouterJevRouteState;
  route?: RouterJevRouteChoiceAnswer;
  needsHuman?: RouterJevNoulAnswer;
  memoryNeeded?: RouterJevNoulAnswer;
  error?: string;
}>;

type SystemOneResponse = {
  model?: string;
  answers?: Record<string, {
    type?: string;
    choice?: string;
    probabilities?: Record<string, number>;
    confidence?: number;
    noul?: number;
  }>;
};

function parseChoiceAnswer(
  answer: SystemOneResponse["answers"] | undefined,
): RouterJevRouteChoiceAnswer | undefined {
  const entry = answer?.route;
  if (!entry || entry.type !== "choice") return undefined;
  const choice = entry.choice === "observe" ? "observe" : entry.choice === "respond" ? "respond" : undefined;
  if (!choice) return undefined;
  const probabilities = entry.probabilities ?? {};
  return Object.freeze({
    choice,
    probabilities: Object.freeze({ ...probabilities }),
    ...(typeof entry.confidence === "number" ? { confidence: entry.confidence } : {}),
  });
}

function parseNoulAnswer(
  answer: SystemOneResponse["answers"] | undefined,
  key: "needsHuman" | "memoryNeeded",
  state: RouterJevRouteState,
): RouterJevNoulAnswer | undefined {
  const entry = answer?.[key];
  if (!entry || entry.type !== "noul" || typeof entry.noul !== "number") return undefined;
  if (key === "memoryNeeded" && state.memoryOptOut) {
    return Object.freeze({ noul: 0, overriddenByOptOut: true });
  }
  return Object.freeze({ noul: entry.noul });
}

export async function callRouterJevJudgment(input: {
  apiKey: string;
  model: string;
  timeoutMs: number;
  message: string;
  source: RouterJevRouteSource;
  channelType?: string;
  botMentioned?: boolean;
  hasFiles?: boolean;
  threadContext?: readonly string[];
  fetchImpl?: typeof fetch;
}): Promise<RouterJevRouteJudgment> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const state = buildRouterJevRouteState(input);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetchImpl(TYPESAFE_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state,
        model: input.model,
        questions: buildRouterJevRouteQuestions(),
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return Object.freeze({
        schema: 1,
        shadow: true,
        model: input.model,
        latencyMs,
        state,
        error: `typesafe_http_${response.status}`,
      });
    }
    const body = await response.json() as SystemOneResponse;
    const model = typeof body.model === "string" ? body.model : input.model;
    return Object.freeze({
      schema: 1,
      shadow: true,
      model,
      latencyMs,
      state,
      ...(parseChoiceAnswer(body.answers) ? { route: parseChoiceAnswer(body.answers) } : {}),
      ...(parseNoulAnswer(body.answers, "needsHuman", state)
        ? { needsHuman: parseNoulAnswer(body.answers, "needsHuman", state) }
        : {}),
      ...(parseNoulAnswer(body.answers, "memoryNeeded", state)
        ? { memoryNeeded: parseNoulAnswer(body.answers, "memoryNeeded", state) }
        : {}),
      ...(!parseChoiceAnswer(body.answers) &&
        !parseNoulAnswer(body.answers, "needsHuman", state) &&
        !parseNoulAnswer(body.answers, "memoryNeeded", state)
        ? { error: "typesafe_missing_answers" }
        : {}),
    });
  } catch (error) {
    return Object.freeze({
      schema: 1,
      shadow: true,
      model: input.model,
      latencyMs: Date.now() - started,
      state,
      error: error instanceof Error ? error.message : "unknown",
    });
  } finally {
    clearTimeout(timer);
  }
}
