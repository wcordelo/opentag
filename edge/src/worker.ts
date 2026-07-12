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
  setCurrentTeamId,
} from "./bot-engine.js";
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
  };

  if (payload?.type === "url_verification" && payload.challenge) {
    return c.json({ challenge: payload.challenge });
  }

  setCurrentTeamId(payload.team_id ?? "unknown");

  const run = async () => {
    const { adapter } = await getOrCreateBot(c.env);
    await adapter.handleEventsBody(payload, { teamId: payload.team_id });
  };

  const exec = c.executionCtx;
  if (exec?.waitUntil) {
    exec.waitUntil(run().catch((err) => console.error("[slack/events]", err)));
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

  setCurrentTeamId(body.team_id ?? "unknown");

  // Immediate ack for Slack's 3s deadline; work continues in waitUntil.
  const run = async () => {
    const { adapter } = await getOrCreateBot(c.env);
    await adapter.handleCommandBody(body);
  };

  const exec = c.executionCtx;
  if (exec?.waitUntil) {
    exec.waitUntil(run().catch((err) => console.error("[slack/commands]", err)));
  } else {
    await run();
  }

  const command = body.command ?? "";
  if (command === "/research") {
    return c.json({
      response_type: "in_channel",
      text: "🔍 Research started…",
    });
  }
  if (command === "/config") {
    return c.json({
      response_type: "ephemeral",
      text: "Updating channel config…",
    });
  }
  return c.json({
    response_type: "in_channel",
    text: "🤖 On it…",
  });
});

app.post("/slack/interactions", slackVerify(), async (c) => {
  const raw = c.get("rawBody");
  let payload: unknown;
  try {
    const params = new URLSearchParams(raw);
    payload = JSON.parse(params.get("payload") ?? raw);
  } catch {
    return c.json({ ok: true });
  }

  const run = async () => {
    const { adapter } = await getOrCreateBot(c.env);
    await adapter.handleInteractionPayload(payload);
  };

  const exec = c.executionCtx;
  if (exec?.waitUntil) {
    exec.waitUntil(
      run().catch((err) => console.error("[slack/interactions]", err)),
    );
  } else {
    await run();
  }

  return c.json({ ok: true });
});

export default app;
