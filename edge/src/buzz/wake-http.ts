/**
 * HTTP adapter for the Buzz wake receive pipeline.
 *
 * Maps orchestration results and {@link BuzzContractError} codes to HTTP
 * responses. Does not own signer custody or Worker bindings — callers pass
 * {@link BuzzWakeReceiveDeps} or leave them unset (fail closed).
 */

import { BuzzContractError } from "./contract.js";
import {
  processBuzzWakeReceive,
  type BuzzWakeReceiveDeps,
  type BuzzWakeReceiveResult,
} from "./receive.js";

export type BuzzWakeHttpJson = Readonly<{
  status: "accepted" | "duplicate" | "error";
  stage?: "pre_fetch" | "authoritative";
  error?: string;
  event_id?: string;
  channel_id?: string;
  conversation_key?: string;
}>;

function jsonResponse(body: BuzzWakeHttpJson, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function mapReceiveResult(result: BuzzWakeReceiveResult): Response {
  if (result.status === "accepted") {
    return jsonResponse({
      status: "accepted",
      event_id: result.inbound.eventId,
      channel_id: result.inbound.channelId,
      conversation_key: result.conversationKey,
    }, 200);
  }
  return jsonResponse({
    status: "duplicate",
    stage: result.stage,
    event_id: result.wake.messageId,
    channel_id: result.wake.channelId,
  }, 200);
}

function mapError(error: unknown): Response {
  if (error instanceof BuzzContractError) {
    const client = error.code.startsWith("buzz_wake_")
      || error.code.startsWith("buzz_receive_")
      || error.code.startsWith("buzz_");
    return jsonResponse(
      { status: "error", error: error.code },
      client ? 400 : 500,
    );
  }
  if (error instanceof Error && error.message === "buzz_receive_fetch_failed") {
    return jsonResponse({ status: "error", error: "buzz_receive_fetch_failed" }, 502);
  }
  return jsonResponse({ status: "error", error: "buzz_receive_internal_error" }, 500);
}

/**
 * Handle an untrusted wake POST body through the full receive pipeline.
 * When `deps` is undefined the route is present but unconfigured — fail closed
 * without touching dedupe, fetch, or runtime.
 */
export async function handleBuzzWakeHttp(
  rawBody: unknown,
  deps: BuzzWakeReceiveDeps | undefined,
): Promise<Response> {
  if (deps === undefined) {
    return jsonResponse({ status: "error", error: "buzz_receive_not_configured" }, 503);
  }
  try {
    const result = await processBuzzWakeReceive(rawBody, deps);
    return mapReceiveResult(result);
  } catch (error) {
    return mapError(error);
  }
}

/** Parse JSON from a Request; malformed JSON → 400 contract error body. */
export async function readBuzzWakeJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new BuzzContractError("buzz_receive_unsupported_content_type");
  }
  try {
    return await request.json();
  } catch {
    throw new BuzzContractError("buzz_receive_invalid_json");
  }
}
