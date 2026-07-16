/**
 * OpenTag edge Worker — Claude Tag bot spine (PRODUCT.md).
 * Slack ingress → CloudflareSlackAdapter → createBot (Channels).
 */
import { Hono } from "hono";
import type { AppEnv } from "./env.js";
import { createDurableObjectStore } from "./store/index.js";
import { slackVerify } from "./slack-verify.js";
import { requireAdminAuth } from "./admin-auth.js";
import {
  getOrCreateBot,
  resolveBotEngineKind,
} from "./bot-engine.js";
import {
  DEFAULT_BUNDLE,
  DEFAULT_SYSTEM_PROMPT,
  type AccessBundle,
  type WorkspaceChannelConfig,
} from "./config/workspace-config-do.js";
import { startTask } from "./tasks/runtime.js";
import {
  extractStopCommandEvent,
  handleStopCommand,
  type SlackEventCallbackPayload,
} from "./slack/stop-routing.js";
import {
  isQuickInteraction,
  handoffPreparedQuickAction,
  prepareQuickAction,
  quickActionEventId,
} from "./slack/quick-actions.js";
import {
  abandonPreAdmittedTurn,
  preAdmissionIdentityForCommand,
  preAdmissionIdentityForEvent,
  preAdmitSlackTurn,
} from "./slack/pre-admit-turn.js";
import { verifySessionViewToken } from "./slack/session-link.js";
import { probeDurabilityHealth } from "./health.js";
import {
  hydrateLateFileRefs,
  lateFileRepairDedupeKey,
  matchLateFileEvent,
  pendingLateFileKey,
  waitForLateFileThreadIdle,
  LATE_FILE_WINDOW_MS,
  type LateFileEvent,
  type PendingFilelessMention,
} from "./slack/late-file-repair.js";
import { createSlackWebClient, sharedSlackRateScheduler } from "./slack/web-api.js";
import { slackObligationThreadKey } from "./slack/obligation-thread-key.js";

export { ConversationStateDO } from "./store/index.js";
export { WorkspaceConfigDO } from "./config/workspace-config-do.js";
export { KnowledgeDO } from "./memory/knowledge-do.js";
export { SessionEventDO } from "./store/session-event-do.js";

const app = new Hono<AppEnv>();

app.get("/sessions/:token", async (c) => {
  const secret = c.env.ADMIN_SECRET;
  if (!secret || !c.env.SESSION_EVENTS) {
    return c.json({ error: "session_view_unavailable" }, 503);
  }
  const claims = await verifySessionViewToken(c.req.param("token"), secret);
  if (!claims) return c.json({ error: "invalid_or_expired_session_link" }, 401);
  const session = c.env.SESSION_EVENTS.get(
    c.env.SESSION_EVENTS.idFromName(claims.threadKey),
  ) as unknown as {
    getState(): Promise<unknown>;
    replay(afterEventId?: number): Promise<unknown[]>;
  };
  const [state, events] = await Promise.all([session.getState(), session.replay()]);
  return c.json({ threadKey: claims.threadKey, state, events }, 200, {
    "cache-control": "private, no-store",
    "x-robots-tag": "noindex, nofollow",
  });
});

app.get("/health", async (c) => {
  const durability = await probeDurabilityHealth(c.env);
  return c.json({
    ok: durability.ok,
    product: "claude-tag-cf",
    store: "durable-object-sqlite",
    spine: ["BOT_STATE", "SESSION_EVENTS", "WORKSPACE_CONFIG", "KNOWLEDGE", "RESEARCH_TASKS"],
    checks: durability.checks,
    botEngine: await resolveBotEngineKind(),
  }, durability.ok ? 200 : 503);
});

app.get("/debug/store", requireAdminAuth(), async (c) => {
  const store = createDurableObjectStore(c.env.BOT_STATE);
  const k = `debug:${crypto.randomUUID()}`;
  await store.kv.set(k, { hello: "edge" }, 5_000);
  const got = await store.kv.get<{ hello: string }>(k);
  await store.list.append(k, "a");
  const list = await store.list.range<string>(k);
  const lock = await store.lock.acquire(`${k}:lock`, { ttlMs: 1_000 });
  if (lock) await store.lock.release(`${k}:lock`, lock.token);
  const firstSeen = await store.dedup.seen(`${k}:evt`, 5_000);
  const secondSeen = await store.dedup.seen(`${k}:evt`, 5_000);
  return c.json({
    kv: got,
    list,
    lock: { acquired: lock !== null },
    dedup: { firstSeen, secondSeen },
  });
});

app.post("/admin/config", requireAdminAuth(), async (c) => {
  const body = (await c.req.json()) as WorkspaceChannelConfig;
  const stub = c.env.WORKSPACE_CONFIG.get(
    c.env.WORKSPACE_CONFIG.idFromName(body.teamId),
  );
  await stub.fetch("https://do/putConfig", {
    method: "POST",
    body: JSON.stringify({
      ...body,
      systemPrompt: body.systemPrompt || DEFAULT_SYSTEM_PROMPT,
      accessBundleId: body.accessBundleId || DEFAULT_BUNDLE.id,
      updatedAt: new Date().toISOString(),
    }),
  });
  return c.json({ ok: true });
});

app.post("/admin/bundle", requireAdminAuth(), async (c) => {
  const body = (await c.req.json()) as AccessBundle & { teamId: string };
  const stub = c.env.WORKSPACE_CONFIG.get(
    c.env.WORKSPACE_CONFIG.idFromName(body.teamId),
  );
  await stub.fetch("https://do/putBundle", {
    method: "POST",
    body: JSON.stringify({
      id: body.id,
      tools: body.tools ?? [],
      mcpEndpoints: body.mcpEndpoints ?? [],
      secretRefs: body.secretRefs ?? [],
    } satisfies AccessBundle),
  });
  return c.json({ ok: true });
});

/** Seed a pending HITL action snapshot key (admin/debug). */
app.post("/debug/hitl", requireAdminAuth(), async (c) => {
  const body = (await c.req.json()) as {
    actionId: string;
    conversationKey: string;
    summary?: string;
  };
  const store = createDurableObjectStore(c.env.BOT_STATE);
  await store.kv.set(
    `hitl:${body.actionId}`,
    {
      actionId: body.actionId,
      conversationKey: body.conversationKey,
      summary: body.summary ?? "approve?",
      status: "pending",
    },
    86_400_000,
  );
  const got = await store.kv.get(`hitl:${body.actionId}`);
  return c.json({ ok: true, gate: got });
});

app.post("/tasks/start", requireAdminAuth(), async (c) => {
  const body = await c.req.json();
  if (
    typeof body !== "object" ||
    body === null ||
    (body as { type?: string }).type !== "research"
  ) {
    return c.json(
      { error: "only type=research is supported until Track F" },
      400,
    );
  }
  const result = await startTask(c.env, body as never);
  return c.json(result);
});

app.post("/slack/events", slackVerify(), async (c) => {
  const payload = c.get("slackPayload") as {
    type?: string;
    challenge?: string;
    team_id?: string;
  } & SlackEventCallbackPayload;

  if (payload?.type === "url_verification" && payload.challenge) {
    return c.json({ challenge: payload.challenge });
  }

  const teamId = payload.team_id ?? "unknown";
  const exec = c.executionCtx;
  const event = payload.event as {
    type?: string;
    channel?: string;
    channel_type?: string;
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    files?: LateFileEvent["files"];
  } | undefined;
  const store = createDurableObjectStore(c.env.BOT_STATE);

  const preAdmissionIdentity = preAdmissionIdentityForEvent(payload);
  if (
    preAdmissionIdentity && event?.type === "app_mention" &&
    (!Array.isArray(event.files) || event.files.length === 0)
  ) {
    const pending: PendingFilelessMention = {
      teamId,
      channelId: preAdmissionIdentity.channelId,
      userId: preAdmissionIdentity.requesterId,
      mentionTs: preAdmissionIdentity.inboundTs,
      threadTs: preAdmissionIdentity.threadTs ?? preAdmissionIdentity.inboundTs,
      eventId: preAdmissionIdentity.eventId,
      expiresAt: Date.now() + LATE_FILE_WINDOW_MS,
    };
    await store.kv.set(pendingLateFileKey(pending), pending, LATE_FILE_WINDOW_MS);
  }

  // Slack may deliver an app_mention before its uploaded file metadata. Match
  // the later file_share to the exact user/channel mention, wait for that
  // original turn to become idle, hydrate files.info, then admit one synthetic
  // continuation with a stable event id. Replays hit the ordinary durable
  // pre-admission dedupe and can never create a second turn.
  if (
    event?.channel && event.user && event.ts &&
    Array.isArray(event.files) && event.files.length > 0
  ) {
    const key = pendingLateFileKey({ teamId, channelId: event.channel, userId: event.user });
    const pending = await store.kv.get<PendingFilelessMention>(key);
    const candidate: LateFileEvent = {
      teamId,
      channelId: event.channel,
      userId: event.user,
      fileTs: event.ts,
      threadTs: event.thread_ts,
      files: event.files,
    };
    if (matchLateFileEvent(pending, candidate)) {
      const repair = async () => {
        const token = c.env.SLACK_BOT_TOKEN;
        const files = token
          ? await hydrateLateFileRefs(candidate.files, async (fileId) =>
              createSlackWebClient(token, {
                scheduler: sharedSlackRateScheduler(c.env.ENVIRONMENT),
              }).getFileInfo(fileId))
          : candidate.files;
        const idle = await waitForLateFileThreadIdle(async () => {
          const active = await store.activeTurn.get(
            slackObligationThreadKey(candidate.channelId, pending!.threadTs),
          );
          return Boolean(active);
        });
        if (!idle) {
          console.error(JSON.stringify({
            metric: "late_file_repair_timeout",
            eventId: pending!.eventId,
            threadTs: pending!.threadTs,
          }));
          return;
        }
        const synthetic = {
          ...payload,
          event_id: lateFileRepairDedupeKey(pending!, { ...candidate, files }),
          event: {
            ...event,
            type: "message",
            subtype: "file_share",
            channel_type: event.channel_type ?? "channel",
            thread_ts: pending!.threadTs,
            text: "Use the newly attached file(s) with my previous request.",
            files,
          },
        } as SlackEventCallbackPayload;
        const identity = preAdmissionIdentityForEvent(synthetic);
        const preAdmittedTurn = await preAdmitSlackTurn(c.env, identity);
        if (!preAdmittedTurn) return;
        let handedOff = false;
        try {
          const { adapter } = await getOrCreateBot(c.env);
          await adapter.handleEventsBody(synthetic, {
            teamId,
            preAdmittedTurn,
            onTurnHandoff: () => { handedOff = true; },
          });
          if (handedOff) await store.kv.delete(key);
        } finally {
          if (!handedOff) await abandonPreAdmittedTurn(c.env, preAdmittedTurn);
        }
      };
      if (exec?.waitUntil) {
        exec.waitUntil(repair().catch((err) => console.error("[slack/events:late-file]", err)));
      } else {
        await repair();
      }
      return c.json({ ok: true });
    }
  }

  // Stop-command routing (GOAL.md Phase A2 Task 1): a matching stop phrase
  // never reaches the bot engine — it interrupts the session + clears
  // status/obligation instead. Anything that isn't a stop command (including
  // a message that merely fails the stop-phrase check) falls through to the
  // normal routing below, unchanged.
  const stopEvent = extractStopCommandEvent(payload);
  if (stopEvent) {
    const runStop = () => handleStopCommand(c.env, stopEvent, payload.event_id);
    if (exec?.waitUntil) {
      exec.waitUntil(
        runStop().catch((err) => console.error("[slack/events:stop]", err)),
      );
    } else {
      await runStop();
    }
    return c.json({ ok: true });
  }

  const run = async () => {
    const identity = preAdmissionIdentity;
    const preAdmittedTurn = await preAdmitSlackTurn(c.env, identity);
    if (identity && !preAdmittedTurn) {
      console.log(JSON.stringify({ metric: "turn_duplicate_pre_admission", eventId: identity.eventId }));
      return;
    }
    let handedOff = false;
    try {
      const { adapter } = await getOrCreateBot(c.env);
      await adapter.handleEventsBody(payload, {
        teamId,
        preAdmittedTurn,
        onTurnHandoff: () => { handedOff = true; },
      });
    } finally {
      if (!handedOff) await abandonPreAdmittedTurn(c.env, preAdmittedTurn);
    }
  };

  if (exec?.waitUntil) {
    exec.waitUntil(
      run().catch(async (err) => {
        console.error("[slack/events]", err);
        // Best-effort: waitUntil cancellation leaves no reply otherwise.
      }),
    );
  } else {
    await run();
  }
  return c.json({ ok: true });
});

app.post("/slack/commands", slackVerify(), async (c) => {
  const raw = c.get("rawBody");
  const params = new URLSearchParams(raw);
  const body = {
    command: params.get("command") ?? undefined,
    text: params.get("text") ?? undefined,
    channel_id: params.get("channel_id") ?? undefined,
    user_id: params.get("user_id") ?? undefined,
    trigger_id: params.get("trigger_id") ?? undefined,
    team_id: params.get("team_id") ?? undefined,
    thread_ts: params.get("thread_ts") ?? undefined,
  };

  const teamId = body.team_id ?? "unknown";

  if (!body.trigger_id) {
    return c.json({ error: "missing_stable_command_identity" }, 400);
  }

  const identity = preAdmissionIdentityForCommand(body);
  const preAdmittedTurn = identity
    ? await preAdmitSlackTurn(c.env, identity)
    : undefined;

  // Immediate ack for Slack's 3s deadline; work continues in waitUntil.
  const run = async () => {
    if (identity && !preAdmittedTurn) {
      console.log(JSON.stringify({ metric: "turn_duplicate_pre_admission", eventId: identity.eventId }));
      return;
    }
    let handedOff = false;
    try {
      const { adapter } = await getOrCreateBot(c.env);
      await adapter.handleCommandBody(body, {
        preAdmittedTurn,
        onTurnHandoff: () => { handedOff = true; },
      });
    } finally {
      if (!handedOff) await abandonPreAdmittedTurn(c.env, preAdmittedTurn);
    }
  };

  const exec = c.executionCtx;
  if (exec?.waitUntil) {
    exec.waitUntil(run().catch((err) => console.error("[slack/commands]", err)));
  } else {
    await run();
  }

  if (identity && !preAdmittedTurn) {
    return c.json({
      response_type: "ephemeral",
      text: "Already handling that command.",
    });
  }

  return c.json({
    response_type: "ephemeral",
    text: "Working on it…",
  });
});

app.post("/slack/interactions", slackVerify(), async (c) => {
  const raw = c.get("rawBody");
  let payload: unknown;
  try {
    const params = new URLSearchParams(raw);
    payload = JSON.parse(params.get("payload") ?? raw);
  } catch {
    return c.json({ error: "invalid_payload" }, 400);
  }

  const teamId =
    typeof payload === "object" &&
    payload !== null &&
    "team" in payload &&
    typeof (payload as { team?: { id?: string } }).team?.id === "string"
      ? (payload as { team: { id: string } }).team.id
      : "unknown";

  // quick_* buttons become synthetic agent turns (SPEC §3.4) — routed INSTEAD
  // of the generic interaction path so a click is never double-handled.
  const isQuick = isQuickInteraction(payload);
  if (isQuick && !quickActionEventId(payload)) {
    return c.json({ error: "missing_stable_click_identity" }, 400);
  }
  const run = async () => {
    const { adapter } = await getOrCreateBot(c.env);
    await adapter.handleInteractionPayload(payload);
  };

  // HITL buttons must not be acknowledged until BOT_STATE has durably
  // received the choice. A 503 is observable and retryable by Slack; returning
  // 200 from waitUntil after a failed write would silently lose the decision.
  if (!isQuick) {
    try {
      await run();
    } catch (err) {
      console.error("[slack/interactions] durable handling failed", err);
      return c.json({ error: "interaction_persistence_failed" }, 503);
    }
    return c.json({ ok: true });
  }


  // Quick clicks follow the same correctness boundary: stable identity and
  // the active-turn + initial obligation transaction MUST be durable before
  // Slack receives 200. Only profile resolution/framework handoff is deferred.
  let prepared;
  try {
    const result = await prepareQuickAction(c.env, payload, teamId);
    if (!result.handled) return c.json({ error: "invalid_quick_action" }, 400);
    prepared = result.prepared;
  } catch (err) {
    console.error("[slack/interactions] quick pre-admission failed", err);
    return c.json({ error: "interaction_persistence_failed" }, 503);
  }
  if (!prepared) return c.json({ ok: true, duplicate: true });

  const handoff = () => handoffPreparedQuickAction(c.env, prepared);

  const exec = c.executionCtx;
  if (exec?.waitUntil) {
    exec.waitUntil(
      handoff().catch((err) => console.error("[slack/interactions]", err)),
    );
  } else {
    await handoff();
  }

  return c.json({ ok: true });
});

export default app;
