/**
 * Workers-native Slack PlatformAdapter — Bolt-free Events API ingress.
 * Uses `@copilotkit/channels-slack` normalize/decode/render; egress via fetch.
 */
import type {
  PlatformAdapter,
  IngressSink,
  IncomingTurn,
  IncomingCommand,
  InteractionEvent,
  ReplyTarget,
  RunRenderer,
  NativePayload,
  ConversationStore,
  UserQuery,
  SurfaceCapabilities,
} from "@copilotkit/channels";
import type {
  BotNode,
  MessageRef,
  PlatformUser,
  ThreadMessage,
} from "@copilotkit/channels-ui";
import {
  createRunRenderer,
  renderBlockKit,
  renderSlackMessage,
  type SlackRenderTransport,
} from "@copilotkit/channels-slack/render";
import {
  normalizeSlackEvent,
  conversationKeyOf,
  decodeInteraction,
  DM_SCOPE,
} from "./channels-slack-lite.js";
import {
  createSlackWebClient,
  isDefinitiveSlackFailure,
  SlackApiError,
  type SlackWebClient,
} from "./web-api.js";
import { conflateChatSdkStream } from "./conflate.js";
import {
  buildMrkdwnBlocks,
  stringsToMarkdownChunks,
  truncateFallbackText,
} from "./stream-render.js";
import {
  getInboundMessage,
  type InboundMessageTarget,
} from "./inbound-target.js";
import { bindRequestContext } from "../request-context.js";
import {
  buildFileContentParts,
  extractSlackFiles,
  mergePromptParts,
  type AgentContentPart,
} from "./download-files.js";

import type { LifecycleStateStore } from "../store/state-store-contract.js";
import { persistHitlChoice } from "../hitl/durable-choice.js";
import {
  renderActiveTurnStep,
  type ActiveTurnRecord,
} from "./active-turn-registry.js";
import type { PreAdmittedTurn } from "./pre-admit-turn.js";
import type { SessionEventDO } from "../store/session-event-do.js";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";

const EXECUTION_FENCE = "__opentagExecutionFence";
const NEXT_RENDER_FINAL = "__opentagNextRenderFinal";
type ExecutionFence = Pick<ActiveTurnRecord, "threadKey" | "executionId">;
type FencedTarget = { [EXECUTION_FENCE]?: ExecutionFence };
type FinalFencedTarget = FencedTarget & { [NEXT_RENDER_FINAL]?: boolean };
type FencedRef = MessageRef & { [EXECUTION_FENCE]?: ExecutionFence };

export class ActiveTurnRenderSuppressedError extends Error {
  constructor() {
    super("active_turn_render_suppressed");
    this.name = "ActiveTurnRenderSuppressedError";
  }
}

/** Mark the next `thread.post` as the turn's final visible effect. */
export function markThreadNextRenderFinal(thread: unknown): void {
  const target = (thread as { deps?: { replyTarget?: unknown } })?.deps?.replyTarget;
  if (!target || typeof target !== "object") return;
  Object.defineProperty(target, NEXT_RENDER_FINAL, {
    value: true,
    configurable: true,
    enumerable: false,
    writable: true,
  });
}

function requireSlackOk<T extends { ok: boolean; error?: string }>(
  method: string,
  result: T,
): T {
  if (!result.ok) throw new SlackApiError(method, result.error ?? "unknown");
  return result;
}

function requireSlackPost<T extends { ok: boolean; ts?: string; error?: string }>(
  result: T,
): T & { ts: string } {
  requireSlackOk("chat.postMessage", result);
  if (!result.ts) throw new SlackApiError("chat.postMessage", "no_ts");
  return result as T & { ts: string };
}

type CloudflareSlackAdapterBaseOptions = {
  botToken: string;
  /** Optional bot user id for loop guards; resolved lazily if omitted. */
  botUserId?: string;
  teamId?: string;
  /**
   * Minimum ms between `chat.update` calls while streaming (default 800).
   * Conflation absorbs bursts while an update is in flight; this is the
   * per-call `Date.now()` throttle floor. Injectable for tests.
   */
  streamUpdateIntervalMs?: number;
  /** Replay source for incremental AG-UI renders (obligation recovery). */
  sessionEvents?: DurableObjectNamespace<SessionEventDO>;
};

/** Production construction always carries the authoritative lifecycle store. */
export type CloudflareSlackAdapterOptions = CloudflareSlackAdapterBaseOptions &
  (
    | {
        stateStore: LifecycleStateStore;
        unsafeAllowUnfencedTestOnly?: false;
      }
    | {
        /** Explicit escape hatch for isolated adapter unit tests only. */
        unsafeAllowUnfencedTestOnly: true;
        stateStore?: LifecycleStateStore;
      }
  );

function messageTsFromRef(
  messageRef: MessageRef,
  fallback?: string,
): string {
  if (typeof messageRef.id === "string" && /^\d+\.\d+$/.test(messageRef.id)) {
    return messageRef.id;
  }
  const extra = messageRef as MessageRef & { ts?: unknown };
  if (typeof extra.ts === "string" && /^\d+\.\d+$/.test(extra.ts)) {
    return extra.ts;
  }
  return fallback && /^\d+\.\d+$/.test(fallback) ? fallback : "";
}

export class CloudflareSlackAdapter implements PlatformAdapter {
  readonly platform = "slack";
  readonly ackDeadlineMs = 3000;
  readonly capabilities: SurfaceCapabilities = {
    supportsModals: false,
    supportsTyping: false,
    supportsReactions: true,
    supportsStreaming: true,
    supportsEphemeral: false,
    maxBlocksPerMessage: 50,
    supportsSuggestedPrompts: false,
    supportsThreadTitle: false,
  };

  private sink: IngressSink | undefined;
  private readonly client: SlackWebClient;
  private botUserId: string | undefined;
  private teamId: string | undefined;
  /** Reuse AG-UI agents within this isolate so mid-thread turns keep message history. */
  private readonly agentsByConversation = new Map<
    string,
    { agent: ReturnType<Parameters<ConversationStore["getOrCreate"]>[2]> }
  >();
  /** Inbound message to react on (CopilotKit IncomingMessage.ref is empty on CF). */
  // Kept in inbound-target.ts so tools can read it without the adapter instance.

  readonly conversationStore: ConversationStore;

  constructor(private readonly opts: CloudflareSlackAdapterOptions) {
    this.client = createSlackWebClient(opts.botToken);
    this.botUserId = opts.botUserId;
    this.teamId = opts.teamId;
    this.conversationStore = {
      getOrCreate: async (conversationKey, _replyTarget, makeAgent) => {
        const hit = this.agentsByConversation.get(conversationKey);
        if (hit) return hit;
        const created = { agent: makeAgent(conversationKey) };
        this.agentsByConversation.set(conversationKey, created);
        return created;
      },
    };
  }

  /**
   * Attach exact execution identity to this request's opaque reply target.
   * The context travels with the Thread/MessageRef; it is not isolate-global
   * mutable state and cannot bleed into another conversation.
   */
  bindExecutionFence(target: unknown, record: ExecutionFence): void {
    if (!target || typeof target !== "object") {
      throw new Error("reply_target_not_fenceable");
    }
    Object.defineProperty(target, EXECUTION_FENCE, {
      value: Object.freeze({ ...record }),
      configurable: true,
      enumerable: false,
      writable: false,
    });
  }

  bindThreadExecutionFence(thread: unknown, record: ExecutionFence): void {
    const target = (thread as { deps?: { replyTarget?: unknown } })?.deps?.replyTarget;
    this.bindExecutionFence(target, record);
  }

  private fenceOf(value: unknown): ExecutionFence | undefined {
    return value && typeof value === "object"
      ? (value as FencedTarget)[EXECUTION_FENCE]
      : undefined;
  }

  /** Best-effort mirror of streamed markdown into SessionEventDO for replay. */
  private async mirrorSessionOutput(
    fence: ExecutionFence | undefined,
    text: string,
  ): Promise<void> {
    if (!fence || !text || !this.opts.sessionEvents) return;
    try {
      const sessionDo = this.opts.sessionEvents.get(
        this.opts.sessionEvents.idFromName(fence.threadKey),
      ) as unknown as {
        appendEvent(args: {
          executionId: string;
          kind: "output";
          payload: unknown;
        }): Promise<unknown>;
      };
      await sessionDo.appendEvent({
        executionId: fence.executionId,
        kind: "output",
        payload: { text },
      });
    } catch (err) {
      console.warn(
        "[slack] session output mirror failed",
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async preAdmittedStillPending(
    turn: PreAdmittedTurn | undefined,
  ): Promise<boolean> {
    if (!turn) return true;
    if (!this.opts.stateStore) throw new Error("lifecycle_state_store_required");
    const snapshot = await this.opts.stateStore.activeTurn.get(turn.record.threadKey);
    return Boolean(
      snapshot &&
        snapshot.record.executionId === turn.record.executionId &&
        snapshot.status === "pending" &&
        !snapshot.stopEventId &&
        !snapshot.renderToken &&
        !snapshot.effectToken,
    );
  }

  private async fenced<T>(
    value: unknown,
    action: () => Promise<T>,
    final = false,
    output = true,
  ): Promise<T> {
    const fence = this.fenceOf(value);
    if (!fence) {
      if (this.opts.unsafeAllowUnfencedTestOnly === true) return action();
      throw new Error("exact_execution_fence_required");
    }
    if (!this.opts.stateStore) {
      throw new Error("lifecycle_state_store_required");
    }
    const target = value as FinalFencedTarget;
    const effectiveFinal = final || target[NEXT_RENDER_FINAL] === true;
    if (target[NEXT_RENDER_FINAL] === true) target[NEXT_RENDER_FINAL] = false;
    const result = await renderActiveTurnStep(
      this.opts.stateStore,
      fence,
      action,
      effectiveFinal,
      { output, isDefinitiveFailure: isDefinitiveSlackFailure },
    );
    if (result.status === "suppressed") {
      throw new ActiveTurnRenderSuppressedError();
    }
    return result.value;
  }

  /** Expose sink for tests after `bot.start()`. */
  getSink(): IngressSink {
    if (!this.sink) {
      throw new Error("CloudflareSlackAdapter: sink not set — call bot.start() first");
    }
    return this.sink;
  }

  async start(sink: IngressSink): Promise<void> {
    this.sink = sink;
    await this.ensureBotUserId();
  }

  async stop(): Promise<void> {
    this.sink = undefined;
  }

  /** Resolve bot user id via auth.test (loop guards + mention dedup). */
  async ensureBotUserId(): Promise<string | undefined> {
    if (this.botUserId) return this.botUserId;
    try {
      const r = await this.client.authTest();
      if (r.ok && r.userId) this.botUserId = r.userId;
    } catch {
      /* leave unset — loop guards degrade gracefully */
    }
    return this.botUserId;
  }

  getBotUserId(): string | undefined {
    return this.botUserId;
  }

  /** Best-effort abort of an in-flight AG-UI run (GOAL.md Phase A2 stop path). */
  abortConversation(conversationKey: string): void {
    const entry = this.agentsByConversation.get(conversationKey);
    const agent = entry?.agent as { abortRun?: () => void } | undefined;
    try {
      agent?.abortRun?.();
    } catch (err) {
      console.error(
        "[slack] abortConversation failed",
        conversationKey,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Handle a verified Events API JSON body (url_verification already handled).
   */
  async handleEventsBody(
    body: unknown,
    meta?: {
      teamId?: string;
      preAdmittedTurn?: PreAdmittedTurn;
      onTurnHandoff?: () => void;
    },
  ): Promise<{ handled: boolean }> {
    if (!this.sink) return { handled: false };
    const bodyTeamId =
      typeof body === "object" && body !== null && "team_id" in body &&
      typeof (body as { team_id?: unknown }).team_id === "string"
        ? (body as { team_id: string }).team_id
        : undefined;
    if (meta?.teamId ?? bodyTeamId) this.teamId = meta?.teamId ?? bodyTeamId;
    await this.ensureBotUserId();
    if (!(await this.preAdmittedStillPending(meta?.preAdmittedTurn))) {
      return { handled: true };
    }

    const normalized = normalizeSlackEvent(
      body as Parameters<typeof normalizeSlackEvent>[0],
      this.botUserId,
    );
    if (!normalized || normalized.kind !== "turn") {
      return { handled: false };
    }

    const isDm = normalized.source === "direct_message";
    // Top-level channel mentions scope on their OWN message ts, not the
    // channel: that ts becomes the root of the reply thread the bot creates,
    // so the mention and every follow-up inside its thread share one
    // conversation by construction. Channel-wide scoping would (a) sever
    // that mention→thread continuity and (b) make all unrelated top-level
    // asks in a channel share one turn lock, memory, and sticky overrides.
    // Slash commands have no message ts, hence their channel-scope fallback —
    // an accepted asymmetry, not a bug.
    const scope = isDm
      ? DM_SCOPE
      : (normalized.threadTs ?? normalized.ts ?? normalized.channel);
    const conversationKey = conversationKeyOf({
      channelId: normalized.channel,
      scope,
    });
    const replyTarget: ReplyTarget = isDm
      ? {
          channel: normalized.channel,
          statusTs: normalized.ts,
          messageTs: normalized.ts,
          recipientUserId: normalized.senderUserId,
        }
      : {
          channel: normalized.channel,
          threadTs: normalized.threadTs ?? normalized.ts,
          messageTs: normalized.ts,
          recipientUserId: normalized.senderUserId,
        };

    if (meta?.preAdmittedTurn) {
      const expected = meta.preAdmittedTurn.record;
      if (
        expected.channelId !== normalized.channel ||
        expected.conversationKey !== conversationKey
      ) {
        throw new Error("pre_admitted_turn_identity_mismatch");
      }
      this.bindExecutionFence(replyTarget, expected);
    }

    const resolvedUser = normalized.senderUserId
      ? await this.client.resolveUser(normalized.senderUserId)
      : undefined;
    if (!(await this.preAdmittedStillPending(meta?.preAdmittedTurn))) {
      return { handled: true };
    }
    // Always allocate a per-turn key even if the web client later caches
    // profiles; reusing a PlatformUser object would reintroduce cross-turn
    // context overwrite for two messages from the same Slack user.
    const user = {
      ...(resolvedUser ?? {}),
      id: resolvedUser?.id ?? normalized.senderUserId ?? "",
    };

    let contentParts: AgentContentPart[] | undefined;
    if (normalized.hasFiles && normalized.files?.length) {
      const refs = extractSlackFiles({ files: normalized.files });
      const { parts, notes } = await buildFileContentParts(
        refs,
        this.opts.botToken,
      );
      const merged = mergePromptParts(normalized.userText, parts, notes);
      if (Array.isArray(merged)) contentParts = merged;
    }
    if (!(await this.preAdmittedStillPending(meta?.preAdmittedTurn))) {
      return { handled: true };
    }

    const turn: IncomingTurn = {
      conversationKey,
      replyTarget,
      userText: normalized.userText,
      contentParts,
      user,
      eventId: normalized.eventId,
      platform: "slack",
    };
    bindRequestContext(user, {
      teamId: meta?.teamId ?? bodyTeamId ?? this.teamId ?? "unknown",
      requesterId: user.id,
      ...(meta?.preAdmittedTurn
        ? { preAdmittedTurn: meta.preAdmittedTurn }
        : {}),
      ...(normalized.ts
        ? {
            inbound: {
              channel: normalized.channel,
              ts: normalized.ts,
              threadTs: normalized.threadTs ?? normalized.ts,
              identity: normalized.eventId,
            },
          }
        : {}),
    });
    if (!(await this.preAdmittedStillPending(meta?.preAdmittedTurn))) {
      return { handled: true };
    }
    meta?.onTurnHandoff?.();
    await this.sink.onTurn(turn);
    return { handled: true };
  }

  /** React to a specific inbound message, or resolve from turn/thread key. */
  async react(
    conversationKey: string,
    emoji: string,
    targetOverride?: InboundMessageTarget,
    fence?: ExecutionFence,
    final = false,
  ): Promise<boolean> {
    const target =
      targetOverride ?? getInboundMessage(conversationKey);
    if (!target) {
      console.error("[slack] react: no inbound target", conversationKey);
      return false;
    }
    const name = emoji.replace(/^:|:$/g, "");
    let r: Awaited<ReturnType<SlackWebClient["addReaction"]>>;
    try {
      r = await this.fenced(
        fence ? { [EXECUTION_FENCE]: fence } : undefined,
        async () => {
          const result = await this.client.addReaction({
            channel: target.channel,
            timestamp: target.ts,
            name,
          });
          if (!result.ok && result.error !== "already_reacted") {
            throw new SlackApiError("reactions.add", result.error ?? "unknown");
          }
          return result;
        },
        final,
        true,
      );
    } catch (err) {
      if (err instanceof ActiveTurnRenderSuppressedError) throw err;
      console.error(
        "[slack] reactions.add failed",
        err instanceof Error ? err.message : err,
        name,
        target.channel,
        target.ts,
      );
      return false;
    }
    return true;
  }

  /** Assistant (DM pane) status indicator — best-effort, errors swallowed by the client. */
  async setStatus(args: {
    channel: string;
    threadTs: string;
    status: string;
    fence?: ExecutionFence;
  }): Promise<void> {
    await this.fenced(
      args.fence ? { [EXECUTION_FENCE]: args.fence } : undefined,
      () => this.client.setStatus({
        channel_id: args.channel,
        thread_ts: args.threadTs,
        status: args.status,
      }),
      false,
      false,
    );
  }

  /** Assistant (DM pane) thread title — best-effort, errors swallowed by the client. */
  async setTitle(args: {
    channel: string;
    threadTs: string;
    title: string;
    fence?: ExecutionFence;
  }): Promise<void> {
    await this.fenced(
      args.fence ? { [EXECUTION_FENCE]: args.fence } : undefined,
      () => this.client.setTitle({
        channel_id: args.channel,
        thread_ts: args.threadTs,
        title: args.title,
      }),
      false,
      false,
    );
  }

  async unreact(
    conversationKey: string,
    emoji: string,
    targetOverride?: InboundMessageTarget,
  ): Promise<boolean> {
    const target =
      targetOverride ?? getInboundMessage(conversationKey);
    if (!target) return false;
    const r = await this.client.removeReaction({
      channel: target.channel,
      timestamp: target.ts,
      name: emoji.replace(/^:|:$/g, ""),
    });
    if (!r.ok && r.error !== "no_reaction") {
      console.error("[slack] reactions.remove failed", r.error, emoji);
      return false;
    }
    return true;
  }

  /** Handle slash-command form body (already URL-decoded params object or raw). */
  async handleCommandBody(body: {
    command?: string;
    text?: string;
    channel_id?: string;
    user_id?: string;
    trigger_id?: string;
    team_id?: string;
    /** Present when the slash command is invoked inside a thread. */
    thread_ts?: string;
  }, meta?: {
    preAdmittedTurn?: PreAdmittedTurn;
    onTurnHandoff?: () => void;
  }): Promise<{ handled: boolean }> {
    if (!this.sink) return { handled: false };
    if (body.team_id) this.teamId = body.team_id;

    const normalized = normalizeSlackEvent(body, this.botUserId);
    if (!normalized || normalized.kind !== "command") {
      return { handled: false };
    }
    if (!normalized.eventId) {
      console.warn("[slack] rejecting slash command without trigger_id");
      return { handled: false };
    }

    const threadTs = body.thread_ts?.trim() || undefined;
    // MUST match preAdmissionIdentityForCommand's derivation exactly — the
    // turn lifecycle rejects a pre-admitted turn whose conversationKey
    // diverges (pre_admitted_turn_identity_mismatch). DMs are one
    // conversation (DM_SCOPE), same as the Events API path.
    const isDmCommand = normalized.channel.startsWith("D");
    const scope = isDmCommand
      ? DM_SCOPE
      : (threadTs ?? normalized.channel);
    const conversationKey = conversationKeyOf({
      channelId: normalized.channel,
      scope,
    });
    let statusTs: string | undefined;
    if (isDmCommand && !threadTs) {
      try {
        const recent = await this.client.getChannelHistory({
          channel: normalized.channel,
          limit: 10,
        });
        statusTs = recent
          .map((m) => m.ts)
          .find((ts): ts is string => Boolean(ts && /^\d+\.\d+$/.test(ts)));
      } catch (err) {
        console.warn(
          "[slack] DM slash status lookup failed",
          err instanceof Error ? err.message : err,
        );
      }
    }
    const replyTarget: ReplyTarget = {
      channel: normalized.channel,
      ...(threadTs ? { threadTs, messageTs: threadTs } : {}),
      ...(statusTs ? { statusTs } : {}),
    };
    if (meta?.preAdmittedTurn) {
      const expected = meta.preAdmittedTurn.record;
      if (
        expected.channelId !== normalized.channel ||
        expected.conversationKey !== conversationKey
      ) {
        throw new Error("pre_admitted_turn_identity_mismatch");
      }
      this.bindExecutionFence(replyTarget, expected);
    }
    const resolvedUser = normalized.senderUserId
      ? await this.client.resolveUser(normalized.senderUserId)
      : undefined;
    if (!(await this.preAdmittedStillPending(meta?.preAdmittedTurn))) {
      return { handled: true };
    }
    const user = {
      ...(resolvedUser ?? {}),
      id: resolvedUser?.id ?? normalized.senderUserId ?? "",
    };
    const cmd: IncomingCommand = {
      command: normalized.command.replace(/^\//, ""),
      text: normalized.text,
      conversationKey,
      replyTarget,
      user,
      eventId: normalized.eventId,
      platform: "slack",
      triggerId: normalized.triggerId,
    };
    // Commands have no message ts, but trigger_id is immutable per invocation.
    // It may identify the turn while never being used as a Slack reaction ts.
    bindRequestContext(user, {
      teamId: body.team_id ?? this.teamId ?? "unknown",
      requesterId: user.id,
      ...(meta?.preAdmittedTurn
        ? { preAdmittedTurn: meta.preAdmittedTurn }
        : {}),
      inbound: {
        channel: normalized.channel,
        ts: normalized.eventId,
        ...(threadTs ? { threadTs } : {}),
        identity: normalized.eventId,
      },
    });
    if (!(await this.preAdmittedStillPending(meta?.preAdmittedTurn))) {
      return { handled: true };
    }
    meta?.onTurnHandoff?.();
    await this.sink.onCommand(cmd);
    return { handled: true };
  }

  /** Handle interactivity payload (parsed JSON from `payload=` form field). */
  async handleInteractionPayload(
    payload: unknown,
  ): Promise<{ handled: boolean }> {
    if (!this.sink) return { handled: false };
    const evt = decodeInteraction(payload);
    if (!evt) return { handled: false };
    // Persist before sink: another isolate may be polling this key while this
    // isolate has no in-memory awaitChoice waiter.
    if (this.opts.stateStore && evt.value !== undefined) {
      try {
        const persisted = await persistHitlChoice(
          this.opts.stateStore,
          evt.conversationKey,
          evt.value,
        );
        console.log(
          "[slack] hitl durable result",
          persisted,
          evt.conversationKey,
          typeof evt.value === "object" &&
            evt.value &&
            "choiceId" in evt.value
            ? (evt.value as { choiceId?: string }).choiceId
            : undefined,
        );
        // Exact-id choices are consumed from the durable receipt. Never also
        // resolve an isolate-local waiter: Stop may atomically replace the
        // receipt with a denial immediately after this RPC returns.
        if (
          persisted === "cancelled" ||
          (typeof evt.value === "object" &&
            evt.value !== null &&
            typeof (evt.value as { choiceId?: unknown }).choiceId === "string")
        ) {
          return { handled: true };
        }
      } catch (err) {
        console.error("[slack] persistHitlChoice failed", err);
        // Durable receipt is authoritative. Returning an error lets Slack
        // retry; invoking the isolate-local sink here could otherwise grant a
        // remote-git approval that BOT_STATE never committed.
        throw err;
      }
    }
    await this.sink.onInteraction(evt);
    return { handled: true };
  }

  render(ir: BotNode[]): NativePayload {
    return renderBlockKit(ir);
  }

  async post(target: ReplyTarget, ir: BotNode[]): Promise<MessageRef> {
    const msg = renderSlackMessage(ir);
    const text = fallbackTextFromIr(ir);
    const channel = String((target as { channel?: string }).channel ?? "");
    const thread_ts = (target as { threadTs?: string }).threadTs;
    const body: Record<string, unknown> = {
      channel,
      thread_ts,
      text,
      unfurl_links: false,
      unfurl_media: false,
    };
    if (msg.accent) {
      body.attachments = [{ color: msg.accent, blocks: msg.blocks }];
    } else {
      body.blocks = msg.blocks;
    }
    const r = await this.fenced(target, async () => requireSlackPost(
      await this.client.postMessage(
      body as {
        channel: string;
        thread_ts?: string;
        text: string;
        blocks?: unknown[];
      }),
    ));
    if (!r.ok || !r.ts) {
      throw new Error(`chat.postMessage failed: ${r.error ?? "unknown"}`);
    }
    const ref: FencedRef = { id: r.ts, channel, ts: r.ts };
    const fence = this.fenceOf(target);
    if (fence) Object.defineProperty(ref, EXECUTION_FENCE, { value: fence });
    return ref;
  }

  async update(ref: MessageRef, ir: BotNode[]): Promise<void> {
    const msg = renderSlackMessage(ir);
    const text = fallbackTextFromIr(ir);
    const channel =
      (ref as { channel?: string }).channel ??
      String((ref as { id?: string }).id ?? "");
    const ts = (ref as { ts?: string }).ts ?? ref.id;
    await this.fenced(ref, async () => requireSlackOk(
      "chat.update",
      await this.client.updateMessage({
      channel,
      ts,
      text,
      blocks: msg.blocks,
      }),
    ));
  }

  /**
   * Incremental Slack render: post one placeholder message, then drain a
   * conflated markdown stream into throttled `chat.update` calls on that
   * same message. Never posts more than one message per call (house rule).
   */
  async stream(
    target: ReplyTarget,
    chunks: AsyncIterable<string>,
  ): Promise<MessageRef> {
    const channel = String((target as { channel?: string }).channel ?? "");
    const thread_ts = (target as { threadTs?: string }).threadTs;

    const placeholderBody: Record<string, unknown> = {
      channel,
      thread_ts,
      text: "…",
      unfurl_links: false,
      unfurl_media: false,
    };
    const placeholder = await this.fenced(target, async () => requireSlackPost(
      await this.client.postMessage(
      placeholderBody as { channel: string; thread_ts?: string; text: string },
      ),
    ));
    if (!placeholder.ok || !placeholder.ts) {
      throw new Error(
        `chat.postMessage failed: ${placeholder.error ?? "unknown"}`,
      );
    }
    const ts = placeholder.ts;
    const intervalMs = this.opts.streamUpdateIntervalMs ?? 800;

    let acc = "";
    let lastUpdateAt = 0;
    let lastSent: string | undefined;
    let lastMirroredLen = 0;
    const fence = this.fenceOf(target);
    const mirrorAccDelta = async (full: string) => {
      if (full.length <= lastMirroredLen) return;
      const delta = full.slice(lastMirroredLen);
      lastMirroredLen = full.length;
      await this.mirrorSessionOutput(fence, delta);
    };

    const attemptUpdate = async (text: string, final: boolean): Promise<void> => {
      await this.fenced(target, async () => requireSlackOk(
          "chat.update",
          await this.client.updateMessage({
          channel,
          ts,
          text: truncateFallbackText(text),
          blocks: buildMrkdwnBlocks(text),
          }),
        ), final,
      );
    };

    // Skip-if-unchanged guard: cheap, safe because `pushUpdate` is always
    // called at least once more (the final call) with the true end state.
    const pushUpdate = async (text: string, isFinal: boolean) => {
      if (text === lastSent && !isFinal) return;
      await mirrorAccDelta(text);
      await attemptUpdate(text, isFinal);
      lastSent = text;
    };

    try {
      const conflated = conflateChatSdkStream(
        stringsToMarkdownChunks(chunks),
      );
      for await (const chunk of conflated) {
        if (chunk.type === "markdown_text") acc += chunk.text;
        const now = Date.now();
        if (now - lastUpdateAt >= intervalMs) {
          await pushUpdate(acc, false);
          lastUpdateAt = now;
        }
      }
    } catch (err) {
      await pushUpdate(`${acc}\n\n⚠️ (stream interrupted)`, true);
      throw err;
    }

    await pushUpdate(acc, true);

    const ref: FencedRef = { id: ts, channel, ts };
    if (fence) Object.defineProperty(ref, EXECUTION_FENCE, { value: fence });
    return ref;
  }

  async delete(_ref: MessageRef): Promise<void> {
    /* no-op for MVP */
  }

  createRunRenderer(target: ReplyTarget): RunRenderer {
    const t = target as {
      channel: string;
      threadTs?: string;
      statusTs?: string;
    };
    let finalMessage: {
      channel: string;
      ts: string;
      text: string;
      blocks?: unknown[];
    } | undefined;
    type SlackUpdateArgs = Parameters<SlackRenderTransport["updateMessage"]>[0];
    let textEndUpdates: SlackUpdateArgs[] | undefined;
    let terminalTextCommitted = false;
    let runErrorPostFinal = false;
    let lastMirroredLen = 0;
    const renderFence = this.fenceOf(target);
    const sendUpdate = async (args: SlackUpdateArgs, final: boolean): Promise<void> => {
      const text = args.text;
      if (text.length > lastMirroredLen) {
        const delta = text.slice(lastMirroredLen);
        lastMirroredLen = text.length;
        await this.mirrorSessionOutput(renderFence, delta);
      }
      await this.fenced(target, async () => requireSlackOk(
        "chat.update",
        await this.client.updateMessage(args),
      ), final);
      finalMessage = {
        channel: args.channel,
        ts: args.ts,
        text: args.text,
      };
      if (final) terminalTextCommitted = true;
    };
    const transport: SlackRenderTransport = {
      setStatus: (args) => this.fenced(
        target,
        () => this.client.setStatus(args),
        false,
        false,
      ),
      postMessage: async (args) => {
        const r = await this.fenced(
          target,
          async () => requireSlackPost(await this.client.postMessage(args)),
          runErrorPostFinal,
        );
        if (!r.ok || !r.ts) {
          console.error(
            "[slack] chat.postMessage failed",
            r.error ?? "no_ts",
            args.channel,
            args.thread_ts,
          );
        }
        if (r.ok && r.ts) {
          finalMessage = {
            channel: args.channel,
            ts: r.ts,
            text: args.text,
          };
          if (runErrorPostFinal) terminalTextCommitted = true;
        }
        return { ts: r.ts };
      },
      updateMessage: async (args) => {
        // TEXT_MESSAGE_END may drain more than one continuation chunk. Buffer
        // those transport calls in the wrapper below so only the actual last
        // visible update is the atomic final lifecycle commit.
        if (textEndUpdates) {
          textEndUpdates.push({ ...args });
          return;
        }
        await sendUpdate(args, false);
      },
    };
    const statusTs = t.threadTs ?? t.statusTs;
    const renderer = createRunRenderer({
      transport,
      target: { channel: t.channel, threadTs: t.threadTs },
      status: statusTs
        ? { threadTs: statusTs, isPane: false }
        : undefined,
      // Prefer reactions / final replies over `:wrench:` / `:white_check_mark:`
      // tool-status chat rows (those confused users into thinking the bot
      // was posting emoji as text).
      showToolStatus: false,
    });
    const baseSubscriber = renderer.subscriber;
    type TextEndArgs = Parameters<
      NonNullable<typeof baseSubscriber.onTextMessageEndEvent>
    >[0];
    const subscriber = {
      ...baseSubscriber,
      onTextMessageEndEvent: async (args: TextEndArgs) => {
        const captured: SlackUpdateArgs[] = [];
        textEndUpdates = captured;
        try {
          await baseSubscriber.onTextMessageEndEvent?.(args);
        } finally {
          textEndUpdates = undefined;
        }
        // A fast stream can already have sent its final bytes before END. In
        // that case, repeat the exact update here (at END, not turn finish) so
        // the user-visible terminal write and durable cleanup are atomic.
        if (captured.length === 0 && finalMessage) {
          captured.push(finalMessage);
        }
        for (let i = 0; i < captured.length; i++) {
          await sendUpdate(captured[i]!, i === captured.length - 1);
        }
      },
      onRunErrorEvent: async (
        args: Parameters<NonNullable<typeof baseSubscriber.onRunErrorEvent>>[0],
      ) => {
        runErrorPostFinal = true;
        try {
          await baseSubscriber.onRunErrorEvent?.(args);
        } finally {
          runErrorPostFinal = false;
        }
      },
    };
    return {
      ...renderer,
      subscriber,
      finish: async () => {
        await renderer.finish?.();
        if (terminalTextCommitted) return;

        // Tool-only and empty AG-UI runs still owe the user a visible terminal
        // result. This final post is also the atomic lifecycle commit point.
        await this.fenced(target, async () => requireSlackPost(
          await this.client.postMessage({
            channel: t.channel,
            thread_ts: t.threadTs,
            text: "_(Agent completed without a text response.)_",
          }),
        ), true);
      },
    };
  }

  async addReaction(
    target: ReplyTarget,
    messageRef: MessageRef,
    emoji: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const t = target as { channel?: string; messageTs?: string };
    const channel = t.channel ?? "";
    const ts = messageTsFromRef(messageRef, t.messageTs);
    if (!channel || !ts) {
      return { ok: false, error: "no_message_target" };
    }
    const name = emoji.replace(/^:|:$/g, "").trim();
    const r = await this.fenced(target, async () => {
      const result = await this.client.addReaction({ channel, timestamp: ts, name });
      if (!result.ok && result.error !== "already_reacted") {
        throw new SlackApiError("reactions.add", result.error ?? "unknown");
      }
      return result;
    }, false, false);
    if (!r.ok && r.error !== "already_reacted") {
      console.error("[slack] reactions.add failed", r.error, name);
      return { ok: false, error: r.error ?? "reactions_add_failed" };
    }
    return { ok: true };
  }

  async removeReaction(
    target: ReplyTarget,
    messageRef: MessageRef,
    emoji: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const t = target as { channel?: string; messageTs?: string };
    const channel = t.channel ?? "";
    const ts = messageTsFromRef(messageRef, t.messageTs);
    if (!channel || !ts) {
      return { ok: false, error: "no_message_target" };
    }
    const name = emoji.replace(/^:|:$/g, "").trim();
    const r = await this.fenced(target, async () => {
      const result = await this.client.removeReaction({ channel, timestamp: ts, name });
      if (!result.ok && result.error !== "no_reaction") {
        throw new SlackApiError("reactions.remove", result.error ?? "unknown");
      }
      return result;
    }, false, false);
    if (!r.ok && r.error !== "no_reaction") {
      console.error("[slack] reactions.remove failed", r.error, name);
      return { ok: false, error: r.error ?? "reactions_remove_failed" };
    }
    return { ok: true };
  }

  decodeInteraction(raw: unknown): InteractionEvent | undefined {
    return decodeInteraction(raw);
  }

  async lookupUser(q: UserQuery): Promise<PlatformUser | undefined> {
    if (!q.query) return undefined;
    return this.client.lookupUserByQuery(q.query);
  }

  async getMessages(target: ReplyTarget): Promise<ThreadMessage[]> {
    const t = target as {
      channel?: string;
      threadTs?: string;
      messageTs?: string;
    };
    if (!t.channel) return [];

    // Threaded channel/group conversations: replies under threadTs.
    // DMs / top-level: conversations.replies(messageTs) only returns that one
    // message — use channel history so the agent keeps prior turns (emails, etc.).
    const raw = t.threadTs
      ? await this.client.getThreadMessages({
          channel: t.channel,
          threadTs: t.threadTs,
          limit: 100,
        })
      : await this.client.getChannelHistory({
          channel: t.channel,
          limit: 50,
        });

    const out: ThreadMessage[] = [];
    for (const m of raw.slice(-100)) {
      if (m.subtype && m.subtype !== "file_share") continue;
      out.push({
        text: m.text ?? "",
        ts: m.ts,
        isBot: Boolean(m.bot_id),
        user: m.user ? await this.client.resolveUser(m.user) : undefined,
      });
    }
    return out;
  }
}

function fallbackTextFromIr(ir: BotNode[]): string {
  const parts: string[] = [];
  const walk = (nodes: BotNode[]) => {
    for (const n of nodes) {
      const props = (n.props ?? {}) as { children?: unknown };
      if (typeof props.children === "string") parts.push(props.children);
      else if (Array.isArray(props.children)) {
        for (const c of props.children) {
          if (typeof c === "string") parts.push(c);
          else if (c && typeof c === "object" && "type" in (c as object)) {
            walk([c as BotNode]);
          }
        }
      }
    }
  };
  walk(ir);
  const s = parts.join(" ").trim();
  return s.length > 0 ? s.slice(0, 200) : "(message)";
}
