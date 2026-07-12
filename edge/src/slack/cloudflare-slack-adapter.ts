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
  type SlackWebClient,
} from "./web-api.js";
import {
  rememberInboundMessage,
  getInboundMessage,
  type InboundMessageTarget,
} from "./inbound-target.js";
import {
  buildFileContentParts,
  extractSlackFiles,
  mergePromptParts,
  type AgentContentPart,
} from "./download-files.js";

export type CloudflareSlackAdapterOptions = {
  botToken: string;
  /** Optional bot user id for loop guards; resolved lazily if omitted. */
  botUserId?: string;
  teamId?: string;
};

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

  /**
   * Handle a verified Events API JSON body (url_verification already handled).
   */
  async handleEventsBody(
    body: unknown,
    meta?: { teamId?: string },
  ): Promise<{ handled: boolean }> {
    if (!this.sink) return { handled: false };
    if (meta?.teamId) this.teamId = meta.teamId;
    await this.ensureBotUserId();

    const normalized = normalizeSlackEvent(
      body as Parameters<typeof normalizeSlackEvent>[0],
      this.botUserId,
    );
    if (!normalized || normalized.kind !== "turn") {
      return { handled: false };
    }

    const isDm = normalized.source === "direct_message";
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

    const user = normalized.senderUserId
      ? await this.client.resolveUser(normalized.senderUserId)
      : undefined;

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

    const turn: IncomingTurn = {
      conversationKey,
      replyTarget,
      userText: normalized.userText,
      contentParts,
      user,
      eventId: normalized.eventId,
      platform: "slack",
    };
    if (normalized.ts) {
      rememberInboundMessage(
        conversationKey,
        normalized.channel,
        normalized.ts,
      );
    }
    await this.sink.onTurn(turn);
    return { handled: true };
  }

  /** React to a specific inbound message, or resolve from turn/thread key. */
  async react(
    conversationKey: string,
    emoji: string,
    targetOverride?: InboundMessageTarget,
  ): Promise<boolean> {
    const target =
      targetOverride ?? getInboundMessage(conversationKey);
    if (!target) {
      console.error("[slack] react: no inbound target", conversationKey);
      return false;
    }
    const name = emoji.replace(/^:|:$/g, "");
    const r = await this.client.addReaction({
      channel: target.channel,
      timestamp: target.ts,
      name,
    });
    if (!r.ok && r.error !== "already_reacted") {
      console.error(
        "[slack] reactions.add failed",
        r.error,
        name,
        target.channel,
        target.ts,
      );
      return false;
    }
    return true;
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
  }): Promise<{ handled: boolean }> {
    if (!this.sink) return { handled: false };
    if (body.team_id) this.teamId = body.team_id;

    const normalized = normalizeSlackEvent(body, this.botUserId);
    if (!normalized || normalized.kind !== "command") {
      return { handled: false };
    }

    const threadTs = body.thread_ts?.trim() || undefined;
    const scope =
      threadTs ?? `slash::${normalized.senderUserId ?? "anon"}`;
    const conversationKey = conversationKeyOf({
      channelId: normalized.channel,
      scope,
    });
    const user = normalized.senderUserId
      ? await this.client.resolveUser(normalized.senderUserId)
      : undefined;
    const cmd: IncomingCommand = {
      command: normalized.command.replace(/^\//, ""),
      text: normalized.text,
      conversationKey,
      replyTarget: {
        channel: normalized.channel,
        ...(threadTs ? { threadTs, messageTs: threadTs } : {}),
      },
      user,
      eventId: normalized.eventId,
      platform: "slack",
      triggerId: normalized.triggerId,
    };
    // Slash commands have no message ts to react to; bind thread parent only so
    // react_message does not reuse a stale event-turn target from request scope.
    if (threadTs && normalized.channel) {
      rememberInboundMessage(conversationKey, normalized.channel, threadTs);
    }
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
    const r = await this.client.postMessage(
      body as {
        channel: string;
        thread_ts?: string;
        text: string;
        blocks?: unknown[];
      },
    );
    if (!r.ok || !r.ts) {
      throw new Error(`chat.postMessage failed: ${r.error ?? "unknown"}`);
    }
    return { id: r.ts, channel, ts: r.ts };
  }

  async update(ref: MessageRef, ir: BotNode[]): Promise<void> {
    const msg = renderSlackMessage(ir);
    const text = fallbackTextFromIr(ir);
    const channel =
      (ref as { channel?: string }).channel ??
      String((ref as { id?: string }).id ?? "");
    const ts = (ref as { ts?: string }).ts ?? ref.id;
    await this.client.updateMessage({
      channel,
      ts,
      text,
      blocks: msg.blocks,
    });
  }

  async stream(
    target: ReplyTarget,
    chunks: AsyncIterable<string>,
  ): Promise<MessageRef> {
    let acc = "";
    for await (const c of chunks) acc += c;
    const r = await this.client.postMessage({
      channel: String((target as { channel?: string }).channel ?? ""),
      thread_ts: (target as { threadTs?: string }).threadTs,
      text: acc || "(empty)",
    });
    return {
      id: r.ts ?? "",
      channel: String((target as { channel?: string }).channel ?? ""),
      ts: r.ts,
    };
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
    const transport: SlackRenderTransport = {
      setStatus: (args) => this.client.setStatus(args),
      postMessage: async (args) => {
        const r = await this.client.postMessage(args);
        if (!r.ok || !r.ts) {
          console.error(
            "[slack] chat.postMessage failed",
            r.error ?? "no_ts",
            args.channel,
            args.thread_ts,
          );
        }
        return { ts: r.ts };
      },
      updateMessage: async (args) => {
        await this.client.updateMessage(args);
      },
    };
    const statusTs = t.threadTs ?? t.statusTs;
    return createRunRenderer({
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
    const r = await this.client.addReaction({
      channel,
      timestamp: ts,
      name,
    });
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
    const r = await this.client.removeReaction({
      channel,
      timestamp: ts,
      name,
    });
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
    const threadTs = t.threadTs ?? t.messageTs;
    if (!t.channel || !threadTs) return [];
    const messages = await this.client.getThreadMessages({
      channel: t.channel,
      threadTs,
      limit: 100,
    });
    const out: ThreadMessage[] = [];
    for (const m of messages.slice(-100)) {
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
