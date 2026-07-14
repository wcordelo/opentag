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
import { copyRequestContext, slackTurnIdentity } from "../request-context.js";
import type { SessionEventsRpc } from "../store/conversation-state-do.js";
import { resolveThreadOverrides } from "../store/thread-overrides.js";
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
import { firstSlackTs, slackObligationThreadKey } from "./obligation-thread-key.js";
import { bindTurnExecutionContext } from "./turn-execution-context.js";

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
  return text || "[non-text prompt]";
}

async function admitSessionExecution(
  env: Env,
  args: {
    threadKey: string;
    executionId: string;
    forwardedMessageId?: string;
    inputLine: string;
  },
): Promise<"accepted" | "duplicate" | "cancelled" | "rejected"> {
  if (!env.SESSION_EVENTS) return "accepted";
  const sessionDo = env.SESSION_EVENTS.get(
    env.SESSION_EVENTS.idFromName(args.threadKey),
  ) as unknown as SessionEventsRpc;
  const executed = await sessionDo.execute({
    executionId: args.executionId,
    forwardedMessageId: args.forwardedMessageId,
    inputLines: [args.inputLine],
  });
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
  } catch {
    // Harness or an earlier terminal may have already closed the execution.
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
  },
): Promise<void> {
  let afterEventId = 0;
  if (env.SESSION_EVENTS) {
    const sessionDo = env.SESSION_EVENTS.get(
      env.SESSION_EVENTS.idFromName(args.threadKey),
    ) as unknown as SessionEventsRpc;
    const events = await sessionDo.replay();
    afterEventId = events.length > 0 ? events[events.length - 1]!.id : 0;
  }
  await stateStore.obligation.set({
    threadKey: args.threadKey,
    executionId: args.executionId,
    afterEventId,
    channel: args.channel,
    threadTs: args.threadTs,
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
  const statusThreadTs = firstSlackTs(
    scope,
    requestContext.inbound?.threadTs,
    requestContext.inbound?.ts,
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
      logMetric("turn_interrupted_pre_admission", {
        threadKey: obligationThreadKey,
        executionId,
      });
      return;
    }
  } else {
    const registration = await registerActiveTurn(stateStore, activeTurn);
    if (!registration.accepted) {
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
    const approvalOverrides = await resolveThreadOverrides(
      stateStore,
      conversationKey,
      approvalText,
    );
    if (!(await isExactTurnPending(stateStore, activeTurn))) {
      logMetric("turn_interrupted_pre_execution", {
        threadKey: obligationThreadKey,
        executionId,
      });
      return;
    }
    const needsRemoteGitApproval = Boolean(
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
    const sessionAdmission = await admitSessionExecution(env, {
      threadKey: obligationThreadKey,
      executionId,
      forwardedMessageId,
      inputLine: sessionInputLine(prompt),
    });
    if (sessionAdmission === "cancelled" || sessionAdmission === "rejected") {
      await stateStore.obligation.clear({
        threadKey: activeTurn.threadKey,
        executionId: activeTurn.executionId,
      });
      if (sessionAdmission === "cancelled") {
        await discardInterruptedActiveTurnRedelivery(stateStore, activeTurn);
      }
      logMetric(
        sessionAdmission === "cancelled"
          ? "turn_interrupted_pre_execution"
          : "turn_concurrent_rejected",
        { threadKey: obligationThreadKey, executionId },
      );
      return;
    }
    if (statusThreadTs) {
      await adapter.setStatus({
        channel: channelId,
        threadTs: statusThreadTs,
        status: "Thinking…",
        fence: activeTurn,
      });
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
