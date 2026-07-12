/**
 * OpenTag edge Worker — Claude Tag bot spine (PRODUCT.md).
 */
import { Hono } from "hono";
import type { AppEnv } from "./env.js";
import { createDurableObjectStore } from "./store/index.js";
import { slackVerify } from "./slack-verify.js";
import { requireAdminAuth } from "./admin-auth.js";
import { resolveHitlGate, saveHitlGate } from "./bot-host.js";
import { resolveBotEngineKind, runSlackTurn } from "./bot-engine.js";
import {
  DEFAULT_BUNDLE,
  DEFAULT_SYSTEM_PROMPT,
  type AccessBundle,
  type WorkspaceChannelConfig,
} from "./config/workspace-config-do.js";
import { startTask } from "./tasks/runtime.js";

export { ConversationStateDO } from "./store/index.js";
export { WorkspaceConfigDO } from "./config/workspace-config-do.js";
export { KnowledgeDO } from "./memory/knowledge-do.js";

const app = new Hono<AppEnv>();

app.get("/health", async (c) =>
  c.json({
    ok: true,
    product: "claude-tag-cf",
    store: "durable-object-sqlite",
    spine: ["BOT_STATE", "WORKSPACE_CONFIG", "KNOWLEDGE", "RESEARCH_TASKS"],
    botEngine: await resolveBotEngineKind(),
  }),
);

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

/** Seed a pending HITL gate (admin/debug). Production uses `confirm:` turns. */
app.post("/debug/hitl", requireAdminAuth(), async (c) => {
  const body = (await c.req.json()) as {
    actionId: string;
    conversationKey: string;
    summary?: string;
  };
  await saveHitlGate(c.env, {
    actionId: body.actionId,
    conversationKey: body.conversationKey,
    summary: body.summary ?? "approve?",
    status: "pending",
  });
  const store = createDurableObjectStore(c.env.BOT_STATE);
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
    event_id?: string;
    team_id?: string;
    event?: {
      type?: string;
      text?: string;
      user?: string;
      channel?: string;
      ts?: string;
      thread_ts?: string;
      bot_id?: string;
    };
  };

  if (payload?.type === "url_verification" && payload.challenge) {
    return c.json({ challenge: payload.challenge });
  }

  const event = payload?.event;
  if (!event || event.bot_id) {
    return c.json({ ok: true });
  }

  const isMention = event.type === "app_mention" || event.type === "message";
  if (!isMention || !event.text || !event.channel || !event.user) {
    return c.json({ ok: true });
  }

  const teamId = payload.team_id ?? "unknown";
  const turn = {
    teamId,
    channelId: event.channel,
    userId: event.user,
    text: event.text.replace(/<@[^>]+>/g, "").trim(),
    threadTs: event.thread_ts,
    messageTs: event.ts,
    eventId: payload.event_id ?? event.ts ?? crypto.randomUUID(),
  };

  const exec = c.executionCtx;
  if (exec?.waitUntil) {
    exec.waitUntil(runSlackTurn(c.env, turn).then(() => undefined));
  } else {
    await runSlackTurn(c.env, turn);
  }
  return c.json({ ok: true });
});

app.post("/slack/commands", slackVerify(), async (c) => {
  const raw = c.get("rawBody");
  const params = new URLSearchParams(raw);
  const command = params.get("command") ?? "";
  const text = params.get("text") ?? "";
  const channelId = params.get("channel_id") ?? "";
  const userId = params.get("user_id") ?? "";
  const teamId = params.get("team_id") ?? "unknown";
  const triggerId = params.get("trigger_id") ?? crypto.randomUUID();

  if (command === "/config") {
    const stub = c.env.WORKSPACE_CONFIG.get(
      c.env.WORKSPACE_CONFIG.idFromName(teamId),
    );
    await stub.fetch("https://do/putConfig", {
      method: "POST",
      body: JSON.stringify({
        teamId,
        channelId,
        systemPrompt: text || DEFAULT_SYSTEM_PROMPT,
        policies: { allowMemoryWrite: true, allowTasks: true },
        accessBundleId: DEFAULT_BUNDLE.id,
        updatedAt: new Date().toISOString(),
      } satisfies WorkspaceChannelConfig),
    });
    return c.json({
      response_type: "ephemeral",
      text: `Channel prompt updated (${text.length} chars). Bundle: \`${DEFAULT_BUNDLE.id}\`.`,
    });
  }

  if (command === "/research") {
    const exec = c.executionCtx;
    const turn = {
      teamId,
      channelId,
      userId,
      text: `research ${text}`,
      eventId: `cmd:${triggerId}`,
    };
    if (exec?.waitUntil) {
      exec.waitUntil(runSlackTurn(c.env, turn).then(() => undefined));
    } else {
      await runSlackTurn(c.env, turn);
    }
    return c.json({
      response_type: "in_channel",
      text: "🔍 Research started…",
    });
  }

  const exec = c.executionCtx;
  const turn = {
    teamId,
    channelId,
    userId,
    text: text || command,
    eventId: `cmd:${triggerId}`,
  };
  if (exec?.waitUntil) {
    exec.waitUntil(runSlackTurn(c.env, turn).then(() => undefined));
  } else {
    await runSlackTurn(c.env, turn);
  }
  return c.json({
    response_type: "in_channel",
    text: "🤖 On it…",
  });
});

app.post("/slack/interactions", slackVerify(), async (c) => {
  const raw = c.get("rawBody");
  let payload: {
    type?: string;
    actions?: Array<{ action_id?: string; value?: string }>;
    channel?: { id?: string };
    message?: { thread_ts?: string; ts?: string };
  };
  try {
    const params = new URLSearchParams(raw);
    payload = JSON.parse(params.get("payload") ?? raw) as typeof payload;
  } catch {
    return c.json({ ok: true });
  }

  const action = payload.actions?.[0];
  const actionId = action?.action_id ?? action?.value;
  if (!actionId) return c.json({ ok: true });

  const decision =
    actionId.endsWith(":deny") || action?.value === "deny"
      ? "denied"
      : "approved";
  const gateId = actionId.replace(/:(approve|deny)$/, "");
  const result = await resolveHitlGate(c.env, gateId, decision);

  if (result.ok && c.env.SLACK_BOT_TOKEN && payload.channel?.id) {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: payload.channel.id,
        thread_ts: payload.message?.thread_ts ?? payload.message?.ts,
        text: `HITL *${result.detail}*: ${result.summary ?? gateId}`,
      }),
    });
  }

  return c.json({
    response_type: "ephemeral",
    text: result.ok
      ? `Recorded ${result.detail} (durable StateStore).`
      : `HITL failed: ${result.detail ?? "unknown"}`,
  });
});

export default app;
