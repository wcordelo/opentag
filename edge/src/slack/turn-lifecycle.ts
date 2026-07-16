import type { PlatformUser } from "@copilotkit/channels-ui";
import {
  runBundledAgentTurn,
  type AgentContentPart,
  type AgentThread,
} from "../agent-turn.js";
import { createBotStoreAdapter } from "../create-bot-store.js";
import type { Env } from "../env.js";
import { newHitlChoiceId } from "../hitl/durable-choice.js";
import {
  awaitRemoteGitApproval,
  requesterForApproval,
} from "../hitl/remote-git-approval.js";
import {
  copyRequestContext,
  requireRequestContext,
  slackTurnIdentity,
} from "../request-context.js";
import type { SessionEventsRpc } from "../store/conversation-state-do.js";
import { extractMessageOverrides } from "./overrides.js";
import { resolveThreadOverrides } from "../store/thread-overrides.js";
import { loadTurnAccess } from "../config/workspace-config-do.js";
import { isRepositoryCodingIntent } from "../coding-intent.js";
import {
  ACTIVE_TURN_TTL_MS,
  discardInterruptedActiveTurnRedelivery,
  refreshActiveTurn,
  registerActiveTurn,
  type ActiveTurnRecord,
} from "./active-turn-registry.js";
import type { CloudflareSlackAdapter } from "./cloudflare-slack-adapter.js";
import { markThreadNextRenderFinal } from "./cloudflare-slack-adapter.js";
import { createSlackWebClient, sharedSlackRateScheduler } from "./web-api.js";
import { firstSlackTs, slackObligationThreadKey } from "./obligation-thread-key.js";
import { bindTurnExecutionContext } from "./turn-execution-context.js";
import { stableSlackClientMessageId } from "./client-message-id.js";

const RENDER_OBLIGATION_TIMEOUT_MS = ACTIVE_TURN_TTL_MS;

function logMetric(metric: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ metric, ...fields }));
}

function sessionInputLine(prompt: string | AgentContentPart[]): string {
  if (typeof prompt === "string") return prompt;
  const text = prompt
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join(" ")
    .trim();
  const attachments = prompt.flatMap((part) => {
    const attachment = part.attachment;
    if (!attachment) return [];
    return [{
      kind: attachment.kind,
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      ...(attachment.stageKey ? { stageKey: attachment.stageKey } : {}),
      ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
    }];
  });
  if (attachments.length === 0) return text || "[non-text prompt]";
  return JSON.stringify({
    type: "opentag_input_v1",
    text: text || "[non-text prompt]",
    attachments,
  });
}

function cleanedSessionInputLine(
  prompt: string | AgentContentPart[],
  cleanedText: string,
): string {
  if (typeof prompt === "string") return cleanedText || "[non-text prompt]";
  const cleanedParts = prompt.map((part) => {
    if (part.type !== "text") return part;
    const cleaned = { ...part, text: extractMessageOverrides(part.text).cleanedText };
    if (part.attachment) {
      Object.defineProperty(cleaned, "attachment", {
        value: part.attachment,
        enumerable: false,
      });
    }
    return cleaned;
  });
  return sessionInputLine(cleanedParts);
}

/**
 * Best-effort "still busy" note for a GENUINE concurrent second ask (a
 * distinct user message while a turn runs) — never-silent applies to
 * rejections too. Duplicates stay silent: a Slack redelivery is a message
 * the user only sent once, and acknowledging it would be noise.
 *
 * Posts via the raw web client, NOT thread.post: the rejection sites run
 * either before any execution fence is bound (adapter.post throws
 * exact_execution_fence_required) or under a fence the LIVE turn owns
 * (render suppressed) — the fence machinery cannot deliver feedback for a
 * turn it rejected. Deduped per thread so rapid-fire messages get at most
 * one note a minute.
 */
async function postTurnRejectedFeedback(
  env: Env,
  stateStore: ReturnType<typeof createBotStoreAdapter>,
  args: {
    reason: "duplicate" | "concurrent";
    channelId: string;
    threadTs?: string;
    liveClientMessageId?: string;
    threadKey: string;
  },
): Promise<void> {
  if (args.reason !== "concurrent") return;
  if (!env.SLACK_BOT_TOKEN) return;
  try {
    const seen = await stateStore.dedup.seen(
      `busy-note:${args.threadKey}`,
      60_000,
    );
    if (seen) return;
    await createSlackWebClient(env.SLACK_BOT_TOKEN, {
      scheduler: sharedSlackRateScheduler(env.ENVIRONMENT, env.SLACK_RATE_LIMIT),
    }).postMessage({
      channel: args.channelId,
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
      text: "⚠️ Another turn is already running in this thread. Send *Stop* to cancel it, then retry.",
    });
  } catch (err) {
    console.warn(
      "[turn] rejection feedback failed",
      err instanceof Error ? err.message : err,
    );
  }
}

async function admitSessionExecution(
  env: Env,
  stateStore: ReturnType<typeof createBotStoreAdapter>,
  args: {
    threadKey: string;
    executionId: string;
    forwardedMessageId?: string;
    inputLine: string;
  },
): Promise<"accepted" | "duplicate" | "cancelled" | "rejected"> {
  if (!env.SESSION_EVENTS) return "accepted";
  // Persist the exact immutable handoff before the cross-DO call. The owning
  // ConversationStateDO alarm retries only this pre-runtime admission; it can
  // never replay model/tool side effects. A short delay gives the request-local
  // fast path first ownership while retaining crash-safe retry state.
  await stateStore.sessionHandoff.start({
    threadKey: args.threadKey,
    executionId: args.executionId,
    forwardedMessageId: args.forwardedMessageId ?? args.executionId,
    inputLines: [args.inputLine],
    delayMs: 250,
  });
  const sessionDo = env.SESSION_EVENTS.get(
    env.SESSION_EVENTS.idFromName(args.threadKey),
  ) as unknown as SessionEventsRpc;
  let executed;
  try {
    executed = await sessionDo.execute({
      executionId: args.executionId,
      forwardedMessageId: args.forwardedMessageId ?? args.executionId,
      inputLines: [args.inputLine],
    });
    try {
      await stateStore.sessionHandoff.clear({
        threadKey: args.threadKey,
        executionId: args.executionId,
      });
    } catch (err) {
      // Exact SessionEvent admission is already definitive. A leftover row
      // can only observe duplicate on alarm; it cannot replay runtime work.
      console.warn(
        "[turn] accepted session handoff cleanup failed",
        err instanceof Error ? err.message : err,
      );
    }
  } catch (initialError) {
    // The durable alarm owns bounded retry after an unaccepted transport/RPC
    // failure. Stay with this invocation long enough to continue only after
    // exact acceptance; never retry runBundledAgentTurn itself.
    const deadline = Date.now() + 7_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const handoff = await stateStore.sessionHandoff.get(args.threadKey);
      if (!handoff || handoff.executionId !== args.executionId) break;
      if (handoff.status === "accepted") {
        await stateStore.sessionHandoff.clear({
          threadKey: args.threadKey,
          executionId: args.executionId,
        });
        return "accepted";
      }
      if (handoff.status === "cancelled") return "cancelled";
      if (handoff.status === "duplicate") return "duplicate";
      if (handoff.status === "exhausted") break;
    }
    throw initialError;
  }
  if (executed.cancelled) return "cancelled";
  if (executed.accepted) return "accepted";
  if (executed.duplicate) return "duplicate";
  return "rejected";
}

async function terminalizeSessionExecution(
  env: Env,
  threadKey: string,
  executionId: string,
): Promise<void> {
  if (!env.SESSION_EVENTS) return;
  const sessionDo = env.SESSION_EVENTS.get(
    env.SESSION_EVENTS.idFromName(threadKey),
  ) as unknown as SessionEventsRpc;
  try {
    await sessionDo.appendEvent({ executionId, kind: "done", payload: {} });
  } catch (err) {
    // Harness or the final renderer may already have closed the execution.
    if (
      err instanceof Error &&
      err.message === `execution_already_terminal:${executionId}`
    ) return;
    throw err;
  }
}

async function isExactTurnPending(
  store: ReturnType<typeof createBotStoreAdapter>,
  record: Pick<ActiveTurnRecord, "threadKey" | "executionId">,
): Promise<boolean> {
  const snapshot = await store.activeTurn.get(record.threadKey);
  return Boolean(
    snapshot &&
      snapshot.record.executionId === record.executionId &&
      snapshot.status === "pending" &&
      !snapshot.renderToken &&
      !snapshot.effectToken,
  );
}

async function writeRenderObligation(
  env: Env,
  stateStore: ReturnType<typeof createBotStoreAdapter>,
  args: {
    threadKey: string;
    executionId: string;
    channel: string;
    threadTs?: string;
    liveClientMessageId?: string;
  },
): Promise<void> {
  let afterEventId = 0;
  if (env.SESSION_EVENTS) {
    const sessionDo = env.SESSION_EVENTS.get(
      env.SESSION_EVENTS.idFromName(args.threadKey),
    ) as unknown as SessionEventsRpc;
    let events;
    try {
      events = await sessionDo.replay();
    } catch (err) {
      throw new Error(
        `session_event_replay_failed:${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    afterEventId = events.length > 0 ? events[events.length - 1]!.id : 0;
  }
  await stateStore.obligation.set({
    threadKey: args.threadKey,
    executionId: args.executionId,
    afterEventId,
    channel: args.channel,
    threadTs: args.threadTs,
    liveClientMessageId: args.liveClientMessageId,
    timeoutMs: RENDER_OBLIGATION_TIMEOUT_MS,
  });
}

/**
 * The single production Slack execution lifecycle. Both Events API turns and
 * `/agent` commands enter here after lightweight non-agent shortcuts.
 */
export async function runSlackTurnLifecycle(
  env: Env,
  adapter: CloudflareSlackAdapter,
  thread: AgentThread,
  prompt: string | AgentContentPart[],
  requester: PlatformUser,
): Promise<void> {
  const stateStore = createBotStoreAdapter(env.BOT_STATE);
  const requestContext = copyRequestContext(requester, thread);
  const conversationKey = thread.conversationKey ?? "";
  const channelId = conversationKey.split("::")[0] ?? "";
  const scope = conversationKey.split("::")[1];
  const replyTarget = (
    thread as { deps?: { replyTarget?: { threadTs?: string; statusTs?: string } } }
  ).deps?.replyTarget;
  const statusThreadTs = firstSlackTs(
    scope,
    requestContext.inbound?.threadTs,
    requestContext.inbound?.ts,
    replyTarget?.threadTs,
    replyTarget?.statusTs,
  );
  const obligationThreadKey = slackObligationThreadKey(
    channelId,
    statusThreadTs,
  );
  const { executionId, forwardedMessageId } = await slackTurnIdentity(
    requestContext,
    channelId,
  );
  const approvalChoiceId = newHitlChoiceId();
  const computedActiveTurn: ActiveTurnRecord = {
    channelId,
    threadKey: obligationThreadKey,
    conversationKey,
    executionId,
    liveClientMessageId: stableSlackClientMessageId(executionId),
    threadTs: statusThreadTs,
    choiceId: approvalChoiceId,
    registeredAt: Date.now(),
  };
  const preAdmitted = requestContext.preAdmittedTurn?.record;
  if (
    preAdmitted &&
    (preAdmitted.threadKey !== computedActiveTurn.threadKey ||
      preAdmitted.executionId !== computedActiveTurn.executionId ||
      preAdmitted.channelId !== computedActiveTurn.channelId ||
      preAdmitted.conversationKey !== computedActiveTurn.conversationKey)
  ) {
    throw new Error("pre_admitted_turn_identity_mismatch");
  }
  const activeTurn: ActiveTurnRecord = preAdmitted ?? computedActiveTurn;
  if (preAdmitted) {
    const refreshed = await refreshActiveTurn(stateStore, activeTurn);
    const snapshot = refreshed
      ? await stateStore.activeTurn.get(activeTurn.threadKey)
      : undefined;
    if (
      !snapshot ||
      snapshot.record.executionId !== activeTurn.executionId ||
      snapshot.status !== "pending" ||
      snapshot.renderToken
    ) {
      await stateStore.obligation.clear({
        threadKey: activeTurn.threadKey,
        executionId: activeTurn.executionId,
      });
      logMetric("turn_interrupted_pre_admission", {
        threadKey: obligationThreadKey,
        executionId,
      });
      return;
    }
  } else {
    const registration = await registerActiveTurn(stateStore, activeTurn);
    if (!registration.accepted) {
      await postTurnRejectedFeedback(env, stateStore, {
        reason: registration.duplicate ? "duplicate" : "concurrent",
        channelId,
        threadTs: statusThreadTs,
        liveClientMessageId: activeTurn.liveClientMessageId,
        threadKey: obligationThreadKey,
      });
      logMetric(
        registration.duplicate ? "turn_duplicate" : "turn_concurrent_rejected",
        { threadKey: obligationThreadKey, executionId },
      );
      return;
    }
  }
  // Carry exact execution identity on this request's opaque reply target so
  // every adapter post/update (including AG-UI incremental rendering) crosses
  // the durable render-step fence.
  adapter.bindThreadExecutionFence(thread, activeTurn);
  bindTurnExecutionContext(thread, activeTurn);

  try {
    const approvalText = Array.isArray(prompt)
      ? prompt
          .filter(
            (part): part is { type: "text"; text: string } =>
              part.type === "text",
          )
          .map((part) => part.text)
          .join(" ")
      : prompt;
    const requestContext = requireRequestContext(thread);
    const { config: channelConfig } = await loadTurnAccess(
      env.WORKSPACE_CONFIG,
      requestContext.teamId,
      channelId,
    );
    const approvalOverrides = await resolveThreadOverrides(
      stateStore,
      conversationKey,
      approvalText,
      channelConfig.runtimeDefaults,
    );
    if (!(await isExactTurnPending(stateStore, activeTurn))) {
      await stateStore.obligation.clear({
        threadKey: activeTurn.threadKey,
        executionId: activeTurn.executionId,
      });
      logMetric("turn_interrupted_pre_execution", {
        threadKey: obligationThreadKey,
        executionId,
      });
      return;
    }
    const needsRemoteGitApproval = Boolean(
      requestContext.actor.kind === "slack_user" &&
      env.HARNESS_REPO_URL &&
        (env.HARNESS || env.HARNESS_URL) &&
        approvalOverrides.effectiveHarnessType === "claudecode" &&
        isRepositoryCodingIntent(approvalOverrides.cleanedText),
    );

    logMetric("turn_started", { threadKey: obligationThreadKey, executionId });
    const existingObligation = await stateStore.obligation.get(obligationThreadKey);
    if (existingObligation?.executionId !== executionId) {
      await writeRenderObligation(env, stateStore, {
        threadKey: obligationThreadKey,
        executionId,
        channel: channelId,
        threadTs: statusThreadTs,
      });
    }
    await refreshActiveTurn(stateStore, activeTurn);
    if (!(await isExactTurnPending(stateStore, activeTurn))) {
      await stateStore.obligation.clear({
        threadKey: activeTurn.threadKey,
        executionId: activeTurn.executionId,
      });
      logMetric("turn_interrupted_pre_execution", {
        threadKey: obligationThreadKey,
        executionId,
      });
      return;
    }
    const sessionAdmission = await admitSessionExecution(env, stateStore, {
      threadKey: obligationThreadKey,
      executionId,
      forwardedMessageId,
      inputLine: cleanedSessionInputLine(prompt, approvalOverrides.cleanedText),
    });
    if (sessionAdmission === "cancelled" || sessionAdmission === "rejected") {
      await stateStore.obligation.clear({
        threadKey: activeTurn.threadKey,
        executionId: activeTurn.executionId,
      });
      if (sessionAdmission === "cancelled") {
        await discardInterruptedActiveTurnRedelivery(stateStore, activeTurn);
      } else {
        await postTurnRejectedFeedback(env, stateStore, {
          reason: "concurrent",
          channelId,
          threadTs: statusThreadTs,
          threadKey: obligationThreadKey,
        });
      }
      logMetric(
        sessionAdmission === "cancelled"
          ? "turn_interrupted_pre_execution"
          : "turn_concurrent_rejected",
        { threadKey: obligationThreadKey, executionId },
      );
      return;
    }
    if (sessionAdmission === "duplicate") {
      await stateStore.activeTurn.abandonPristine({
        threadKey: activeTurn.threadKey,
        executionId: activeTurn.executionId,
      });
      // Duplicate admission = redelivery of the original message; deliberate
      // silence (postTurnRejectedFeedback no-ops on "duplicate").
      logMetric("turn_duplicate", { threadKey: obligationThreadKey, executionId });
      return;
    }
    await writeRenderObligation(env, stateStore, {
      threadKey: obligationThreadKey,
      executionId,
      channel: channelId,
      threadTs: statusThreadTs,
    });
    if (statusThreadTs) {
      try {
        await adapter.setStatus({
          channel: channelId,
          threadTs: statusThreadTs,
          status: "Thinking…",
          fence: activeTurn,
        });
      } catch (err) {
        // Progress is cosmetic. Exact output/effect fences remain authoritative;
        // rate limits or missing Slack status support must not abort execution.
        console.warn(
          "[turn] initial status failed",
          err instanceof Error ? err.message : err,
        );
      }
    }

    const remoteGit = needsRemoteGitApproval
      ? await awaitRemoteGitApproval(
          thread as Parameters<typeof awaitRemoteGitApproval>[0],
          stateStore,
          {
            repository: env.HARNESS_REPO_URL!,
            requester: requesterForApproval(requester),
            choiceId: approvalChoiceId,
          },
        )
      : { remoteGitApproved: false, createPullRequest: false };
    await refreshActiveTurn(stateStore, activeTurn);
    if (!(await isExactTurnPending(stateStore, activeTurn))) {
      await stateStore.obligation.clear({
        threadKey: activeTurn.threadKey,
        executionId: activeTurn.executionId,
      });
      logMetric("turn_interrupted_pre_execution", {
        threadKey: obligationThreadKey,
        executionId,
      });
      return;
    }
    const outcome = await runBundledAgentTurn(env, thread, prompt, requester, {
      executionId,
      forwardedMessageId,
      remoteGitApproved: remoteGit.remoteGitApproved,
      createPullRequest: remoteGit.createPullRequest,
    });
    if (outcome.status === "interrupted") {
      logMetric("turn_interrupted", {
        threadKey: obligationThreadKey,
        executionId,
      });
    } else if (outcome.status === "rejected") {
      await stateStore.obligation.clear({
        threadKey: activeTurn.threadKey,
        executionId: activeTurn.executionId,
      });
      await postTurnRejectedFeedback(env, stateStore, {
        reason: outcome.reason === "duplicate" ? "duplicate" : "concurrent",
        channelId,
        threadTs: statusThreadTs,
        threadKey: obligationThreadKey,
      });
      logMetric(
        outcome.reason === "duplicate"
          ? "turn_duplicate"
          : "turn_concurrent_rejected",
        { threadKey: obligationThreadKey, executionId },
      );
    } else {
      logMetric("turn_completed", { threadKey: obligationThreadKey, executionId });
      if (!outcome.terminalPersisted) {
        await terminalizeSessionExecution(env, obligationThreadKey, executionId);
      }
    }
    // Every completed path terminalizes on its actual final Slack request:
    // harness/direct posts mark that request final and the AG-UI renderer
    // performs an idempotent final update (or a tool-only fallback post).
    // Never clear the row here after visible output; that would recreate an
    // answer-then-Stop gap. Interrupted/rejected turns retain the obligation
    // until exact cancellation is visibly confirmed or recovery renders.
    if (outcome.status === "interrupted") {
      // This invocation registered only after the earlier Stop lifecycle had
      // already cleared its confirmed active row. SessionEventDO's exact
      // tombstone is therefore proof of a prior confirmed cancellation. The
      // atomic CAS refuses to clear if a new Stop claimed this fresh row.
      await discardInterruptedActiveTurnRedelivery(stateStore, activeTurn);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logMetric("turn_failed", { threadKey: obligationThreadKey, executionId });
    console.error("[bot] Slack turn failed", msg);
    if (
      msg.startsWith("session_event_mirror_failed:") ||
      msg.startsWith("session_event_replay_failed:")
    ) {
      // Canonical session state is unavailable or incomplete. Do not start a
      // different runtime, append done, post a final error, or clear the
      // obligation; the exact active lifecycle remains retryable.
      return;
    }
    try {
      markThreadNextRenderFinal(thread);
      await thread.post(
        `⚠️ Something went wrong (agent didn't finish): ${msg.slice(0, 180)}\n` +
          "Check AGENT_RUNTIME / opentag-agent — retry in a few seconds.",
      );
    } catch {
      // Leave an outstanding obligation for alarm recovery when no error card landed.
    }
  } finally {
    if (statusThreadTs) {
      try {
        await adapter.setStatus({
          channel: channelId,
          threadTs: statusThreadTs,
          status: "",
          fence: activeTurn,
        });
      } catch {
        // A final render or Stop may already have atomically removed the row.
        // Never launch a delayed status mutation after lifecycle exit.
      }
    }
  }
}
