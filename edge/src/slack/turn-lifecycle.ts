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
  clearActiveTurn,
  registerActiveTurn,
  type ActiveTurnRecord,
} from "./active-turn-registry.js";
import type { CloudflareSlackAdapter } from "./cloudflare-slack-adapter.js";
import { firstSlackTs, slackObligationThreadKey } from "./obligation-thread-key.js";

const RENDER_OBLIGATION_TIMEOUT_MS = 20 * 60_000;

function logMetric(metric: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ metric, ...fields }));
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
  try {
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
  } catch (err) {
    console.error("[bot] render obligation write failed", err);
  }
}

async function clearRenderObligation(
  stateStore: ReturnType<typeof createBotStoreAdapter>,
  threadKey: string,
  executionId: string,
): Promise<void> {
  try {
    await stateStore.obligation.clear({ threadKey, executionId });
  } catch (err) {
    console.error("[bot] render obligation clear failed", err);
  }
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
  const activeTurn: ActiveTurnRecord = {
    channelId,
    threadKey: obligationThreadKey,
    conversationKey,
    executionId,
    threadTs: statusThreadTs,
    choiceId: approvalChoiceId,
    registeredAt: Date.now(),
  };
  const registration = await registerActiveTurn(stateStore, activeTurn);
  if (!registration.accepted) {
    logMetric(
      registration.duplicate ? "turn_duplicate" : "turn_concurrent_rejected",
      { threadKey: obligationThreadKey, executionId },
    );
    return;
  }

  let obligationWritten = false;
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
    const needsRemoteGitApproval = Boolean(
      env.HARNESS_REPO_URL &&
        (env.HARNESS || env.HARNESS_URL) &&
        approvalOverrides.effectiveHarnessType === "claudecode" &&
        isRepositoryCodingIntent(approvalOverrides.cleanedText),
    );

    if (statusThreadTs) {
      void adapter
        .setStatus({
          channel: channelId,
          threadTs: statusThreadTs,
          status: "Thinking…",
        })
        .catch(() => undefined);
    }
    logMetric("turn_started", { threadKey: obligationThreadKey, executionId });
    await writeRenderObligation(env, stateStore, {
      threadKey: obligationThreadKey,
      executionId,
      channel: channelId,
      threadTs: statusThreadTs,
    });
    obligationWritten = true;

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
    }
    await clearRenderObligation(stateStore, obligationThreadKey, executionId);
    obligationWritten = false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logMetric("turn_failed", { threadKey: obligationThreadKey, executionId });
    console.error("[bot] Slack turn failed", msg);
    try {
      await thread.post(
        `⚠️ Something went wrong (agent didn't finish): ${msg.slice(0, 180)}\n` +
          "Check AGENT_RUNTIME / opentag-agent — retry in a few seconds.",
      );
      if (obligationWritten) {
        await clearRenderObligation(stateStore, obligationThreadKey, executionId);
        obligationWritten = false;
      }
    } catch {
      // Leave an outstanding obligation for alarm recovery when no error card landed.
    }
  } finally {
    if (statusThreadTs) {
      void adapter
        .setStatus({ channel: channelId, threadTs: statusThreadTs, status: "" })
        .catch(() => undefined);
    }
    try {
      await clearActiveTurn(stateStore, activeTurn);
    } catch {
      // Compare-delete cleanup is best-effort; TTL bounds stale records.
    }
  }
}
