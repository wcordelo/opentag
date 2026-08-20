/**
 * Live Slack progress message for harness turns.
 * One stable progress message per execution (separate from the final answer).
 */
import type { LifecycleStateStore } from "../store/state-store-contract.js";
import { renderActiveTurnStep } from "./active-turn-registry.js";
import { stableSlackClientMessageId } from "./client-message-id.js";
import type { SlackWebClient } from "./web-api.js";
import { isDefinitiveSlackFailure } from "./web-api.js";
import {
  applyProgressEvent,
  renderProgressMarkdown,
  type ProgressItem,
} from "./harness-progress.js";

export function harnessProgressClientMessageId(executionId: string): string {
  return stableSlackClientMessageId(`${executionId}:harness-progress`);
}

export type HarnessProgressLiveRenderer = {
  handleEvent(event: { kind: "context" | "progress"; payload: unknown }): Promise<void>;
  markTerminal(opts: { ok: boolean; interrupted?: boolean }): Promise<void>;
  contextLine(): string;
  /** Final answer must not include progress markdown. */
  finalAnswerPrefix(): string;
};

const MIN_UPDATE_INTERVAL_MS = 800;

export function createHarnessProgressLiveRenderer(opts: {
  store: LifecycleStateStore;
  client: SlackWebClient;
  channelId: string;
  threadTs?: string;
  threadKey: string;
  executionId: string;
  now?: () => number;
  /** Optional progress section heading. */
  progressHeading?: string;
}): HarnessProgressLiveRenderer {
  const items = new Map<string, ProgressItem>();
  let progressTs: string | undefined;
  let lastPosted = "";
  let lastUpdateAt = 0;
  let terminal = false;
  let pending: Promise<void> = Promise.resolve();
  const now = opts.now ?? Date.now;
  const progressHeading = opts.progressHeading ?? "*Coding progress*";

  const clientMessageId = harnessProgressClientMessageId(opts.executionId);

  function markdown(done?: boolean, failed?: boolean): string {
    if (items.size === 0) return "";
    return renderProgressMarkdown(items.values(), {
      done,
      failed,
      heading: progressHeading,
    });
  }

  async function ensurePosted(text: string): Promise<void> {
    if (terminal) return;
    if (!text.trim()) return;
    if (progressTs) {
      if (text === lastPosted) return;
      if (now() - lastUpdateAt < MIN_UPDATE_INTERVAL_MS) return;
      const step = await renderActiveTurnStep(
        opts.store,
        { threadKey: opts.threadKey, executionId: opts.executionId },
        async () => {
          await opts.client.updateMessage({
            channel: opts.channelId,
            ts: progressTs!,
            text,
          });
          return true;
        },
        false,
        { output: false, isDefinitiveFailure: isDefinitiveSlackFailure },
      );
      if (step.status === "suppressed") {
        terminal = true;
        return;
      }
      lastPosted = text;
      lastUpdateAt = now();
      return;
    }

    const step = await renderActiveTurnStep(
      opts.store,
      { threadKey: opts.threadKey, executionId: opts.executionId },
      async () => {
        const posted = await opts.client.postMessage({
          channel: opts.channelId,
          ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
          text,
          client_msg_id: clientMessageId,
        });
        return posted.ts;
      },
      false,
      { output: false, isDefinitiveFailure: isDefinitiveSlackFailure },
    );
    if (step.status === "suppressed") {
      terminal = true;
      return;
    }
    progressTs = step.value;
    lastPosted = text;
    lastUpdateAt = now();
  }

  async function forceUpdate(text: string): Promise<void> {
    if (terminal || !text.trim()) return;
    if (!progressTs) {
      await ensurePosted(text);
      return;
    }
    const step = await renderActiveTurnStep(
      opts.store,
      { threadKey: opts.threadKey, executionId: opts.executionId },
      async () => {
        await opts.client.updateMessage({
          channel: opts.channelId,
          ts: progressTs!,
          text,
          ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
          knowledgeIndex: true,
        });
        return true;
      },
      false,
      { output: false, isDefinitiveFailure: isDefinitiveSlackFailure },
    );
    if (step.status === "suppressed") {
      terminal = true;
      return;
    }
    lastPosted = text;
    lastUpdateAt = now();
  }

  function enqueue(work: () => Promise<void>): Promise<void> {
    pending = pending.then(work, work);
    return pending;
  }

  return {
    handleEvent(event) {
      return enqueue(async () => {
        if (terminal) return;
        if (event.kind === "progress" && event.payload && typeof event.payload === "object") {
          const p = event.payload as Record<string, unknown>;
          if (
            typeof p.progressId === "string" &&
            typeof p.sequence === "number" &&
            typeof p.title === "string"
          ) {
            const applied = applyProgressEvent(items, {
              progressId: p.progressId,
              sequence: p.sequence,
              category:
                p.category === "commentary" ||
                p.category === "task" ||
                p.category === "tool"
                  ? p.category
                  : "task",
              state:
                p.state === "started" ||
                p.state === "updated" ||
                p.state === "completed" ||
                p.state === "failed"
                  ? p.state
                  : "updated",
              title: p.title,
              ...(typeof p.summary === "string" ? { summary: p.summary } : {}),
            });
            if (applied.changed) {
              items.clear();
              for (const [k, v] of applied.items) items.set(k, v);
            }
          }
        }
        await ensurePosted(markdown());
      });
    },
    markTerminal(optsMark) {
      return enqueue(async () => {
        await forceUpdate(
          markdown(optsMark.ok && !optsMark.interrupted, !optsMark.ok || optsMark.interrupted),
        );
        terminal = true;
      });
    },
    contextLine() {
      return "";
    },
    finalAnswerPrefix() {
      return "";
    },
  };
}
