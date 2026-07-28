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
  formatContextLine,
  renderProgressMarkdown,
  type HarnessContextLine,
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
}): HarnessProgressLiveRenderer {
  const items = new Map<string, ProgressItem>();
  let context: HarnessContextLine | undefined;
  let progressTs: string | undefined;
  let lastPosted = "";
  let lastUpdateAt = 0;
  let terminal = false;
  let pending: Promise<void> = Promise.resolve();
  const now = opts.now ?? Date.now;

  const clientMessageId = harnessProgressClientMessageId(opts.executionId);

  function markdown(done?: boolean, failed?: boolean): string {
    const parts: string[] = [];
    if (context) parts.push(formatContextLine(context));
    if (items.size > 0) {
      parts.push(renderProgressMarkdown(items.values(), { done, failed }));
    } else if (context) {
      parts.push(done ? "_Complete_" : failed ? "_Interrupted or failed_" : "_Working…_");
    }
    return parts.join("\n\n");
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
        if (event.kind === "context" && event.payload && typeof event.payload === "object") {
          const p = event.payload as Record<string, unknown>;
          const next: HarnessContextLine = {
            harnessType:
              typeof p.harnessType === "string" ? p.harnessType : "claudecode",
            model: typeof p.model === "string" ? p.model : undefined,
            modelEvidence:
              p.modelEvidence === "requested" ||
              p.modelEvidence === "container_argument" ||
              p.modelEvidence === "provider_reported" ||
              p.modelEvidence === "unknown"
                ? p.modelEvidence
                : "unknown",
          };
          const evidenceRank: Record<HarnessContextLine["modelEvidence"], number> = {
            unknown: 0,
            requested: 1,
            container_argument: 2,
            provider_reported: 3,
          };
          if (
            !context ||
            evidenceRank[next.modelEvidence] >= evidenceRank[context.modelEvidence]
          ) {
            context = next;
          }
        }
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
      return context ? formatContextLine(context) : "";
    },
    finalAnswerPrefix() {
      // Context line may appear once above the final answer; progress stays
      // on its own message and must never enter final answer text.
      return context ? `${formatContextLine(context)}\n\n` : "";
    },
  };
}
