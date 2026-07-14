import type { Renderable } from "@copilotkit/channels-ui";
import { RemoteGitApprovalCard } from "../components/cards.js";
import type { StateStore } from "../store/state-store-contract.js";
import {
  awaitChoiceDurable,
  HITL_CHOICE_TIMEOUT_MS,
  newHitlChoiceId,
} from "./durable-choice.js";
export { isRepositoryCodingIntent } from "../coding-intent.js";

type ApprovalThread = {
  conversationKey?: string;
  awaitChoice<T = unknown>(ui: Renderable): Promise<T>;
};

export type RemoteGitApproval = {
  remoteGitApproved: boolean;
  createPullRequest: boolean;
};

const DENY_REMOTE_GIT: RemoteGitApproval = {
  remoteGitApproved: false,
  createPullRequest: false,
};

export function repositoryForDisplay(repository: string): string {
  try {
    const url = new URL(repository);
    url.username = "";
    url.password = "";
    return `${url.host}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return repository.replace(/^[^@\s/]+@/, "").slice(0, 300);
  }
}

export function requesterForApproval(requester?: {
  id?: string;
  handle?: string;
  name?: string;
}): string {
  if (requester?.handle) return `@${requester.handle.replace(/^@/, "")}`;
  if (requester?.id) return `<@${requester.id}>`;
  return requester?.name?.trim() || "the Slack requester";
}

/**
 * The only path that can grant remote-git + PR capability to a Slack turn.
 * Cancel, dismissal, malformed values, and timeout all fail closed.
 */
export async function awaitRemoteGitApproval(
  thread: ApprovalThread,
  store: StateStore,
  args: {
    repository: string;
    requester: string;
    choiceId?: string;
    timeoutMs?: number;
    pollMs?: number;
    unsafeAllowMissingExecutionContextTestOnly?: boolean;
  },
): Promise<RemoteGitApproval> {
  const choiceId = args.choiceId ?? newHitlChoiceId();
  try {
    const choice = await awaitChoiceDurable<{
      confirmed?: boolean;
      choiceId?: string;
    }>(
      thread,
      store,
      RemoteGitApprovalCard({
        repository: repositoryForDisplay(args.repository),
        requester: args.requester,
        choiceId,
      }),
      {
        choiceId,
        conversationKey: thread.conversationKey,
        timeoutMs: args.timeoutMs ?? HITL_CHOICE_TIMEOUT_MS,
        pollMs: args.pollMs,
        requireDurableReceipt: true,
        ...(args.unsafeAllowMissingExecutionContextTestOnly
          ? { unsafeAllowMissingExecutionContextTestOnly: true }
          : {}),
      },
    );
    if (choice?.confirmed !== true || choice.choiceId !== choiceId) {
      return DENY_REMOTE_GIT;
    }
    return { remoteGitApproved: true, createPullRequest: true };
  } catch (err) {
    console.warn(
      "[remote-git-approval] declined or timed out",
      err instanceof Error ? err.message : err,
    );
    return DENY_REMOTE_GIT;
  }
}
