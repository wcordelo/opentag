/**
 * Bot host — StateStore-backed turn handling (PRODUCT.md).
 * Used when createBot is unavailable on Workers; same store contract.
 */
import { createDurableObjectStore } from "./store/index.js";
import { loadTurnAccess } from "./config/workspace-config-do.js";
import { resolveAllowedTools } from "./config/access-bundle.js";
import { memorySearch, memoryWrite } from "./memory/knowledge-do.js";
import { startTask } from "./tasks/runtime.js";
import type { Env } from "./env.js";

export type SlackTurn = {
  teamId: string;
  channelId: string;
  userId: string;
  text: string;
  threadTs?: string;
  eventId: string;
  messageTs?: string;
};

const ALL_TOOLS = [
  "confirm_write",
  "research_progress",
  "memory_search",
  "memory_write",
  "start_task",
  "show_status",
  "file_issue",
];

export async function handleSlackTurn(
  env: Env,
  turn: SlackTurn,
): Promise<{ ok: boolean; detail?: string }> {
  const store = createDurableObjectStore(env.BOT_STATE);
  const conversationKey = `${turn.channelId}::${turn.threadTs ?? turn.channelId}`;

  const already = await store.dedup.seen(`slack:evt:${turn.eventId}`, 600_000);
  if (already) return { ok: true, detail: "deduped" };

  const lockKey = `turn:${conversationKey}`;
  const lock = await store.lock.acquire(lockKey, { ttlMs: 30_000 });
  if (!lock) return { ok: true, detail: "turn_locked" };

  try {
    const { config, bundle } = await loadTurnAccess(
      env.WORKSPACE_CONFIG,
      turn.teamId,
      turn.channelId,
    );
    const tools = resolveAllowedTools(ALL_TOOLS, bundle);
    const toolSet = new Set(tools);

    const prev =
      (await store.kv.get<{
        hits: number;
        lastText?: string;
        transcript?: Array<{ role: string; text: string }>;
      }>(`threadstate:${conversationKey}`)) ?? { hits: 0, transcript: [] };
    const transcript = [
      ...(prev.transcript ?? []).slice(-20),
      { role: "user", text: turn.text },
    ];
    await store.kv.set(`threadstate:${conversationKey}`, {
      hits: prev.hits + 1,
      lastText: turn.text,
      systemPrompt: config.systemPrompt,
      tools,
      secretRefs: bundle.secretRefs,
      mcpEndpoints: bundle.mcpEndpoints,
      transcript,
    });

    const threadTs = turn.threadTs ?? turn.messageTs;

    // HITL: "confirm: <action>" → durable gate + Block Kit buttons.
    const confirmMatch = turn.text.match(/^\s*confirm[:\s]+(.+)/i);
    if (confirmMatch) {
      if (!toolSet.has("confirm_write")) {
        await postSlack(env, {
          channel: turn.channelId,
          thread_ts: threadTs,
          text: "⛔ `confirm_write` is not in this channel's access bundle.",
        });
        return { ok: true, detail: "bundle_deny_confirm" };
      }
      const actionId = crypto.randomUUID();
      const summary = confirmMatch[1]!.trim();
      await saveHitlGate(env, {
        actionId,
        conversationKey,
        summary,
        status: "pending",
      });
      await postSlack(env, {
        channel: turn.channelId,
        thread_ts: threadTs,
        text: `⚠️ Confirm: ${summary}`,
        blocks: hitlBlocks(actionId, summary),
      });
      return { ok: true, detail: "hitl_pending" };
    }

    const researchMatch = turn.text.match(
      /^\s*(?:research[:\s]+|\/research\s+)(.+)/i,
    );
    if (researchMatch) {
      if (config.policies.allowTasks === false || !toolSet.has("start_task")) {
        await postSlack(env, {
          channel: turn.channelId,
          thread_ts: threadTs,
          text: "⛔ Research / `start_task` is not allowed by this channel's access bundle.",
        });
        return { ok: true, detail: "bundle_deny_task" };
      }
      const objective = researchMatch[1]!.trim();
      const threadKey = `slack:${turn.channelId}:${threadTs ?? turn.channelId}`;
      const result = await startTask(env, {
        type: "research",
        teamId: turn.teamId,
        threadKey,
        channelId: turn.channelId,
        threadTs: turn.threadTs,
        payload: { objective },
      });
      await postSlack(env, {
        channel: turn.channelId,
        thread_ts: threadTs,
        text: `🔍 Research ${result.status}: \`${result.taskId}\`${result.detail ? ` — ${result.detail}` : ""}`,
      });
      return { ok: true, detail: "research_task" };
    }

    const rememberMatch = turn.text.match(/^\s*remember[:\s]+(.+)/i);
    if (rememberMatch) {
      if (
        config.policies.allowMemoryWrite === false ||
        !toolSet.has("memory_write")
      ) {
        await postSlack(env, {
          channel: turn.channelId,
          thread_ts: threadTs,
          text: "⛔ `memory_write` is not allowed by this channel's access bundle.",
        });
        return { ok: true, detail: "bundle_deny_memory" };
      }
      await memoryWrite(env.KNOWLEDGE, {
        id: crypto.randomUUID(),
        teamId: turn.teamId,
        channelId: turn.channelId,
        title: `note-${new Date().toISOString().slice(0, 10)}`,
        body: rememberMatch[1]!.trim(),
        updatedAt: new Date().toISOString(),
      });
      await postSlack(env, {
        channel: turn.channelId,
        thread_ts: threadTs,
        text: "💾 Saved to channel knowledge.",
      });
      return { ok: true, detail: "memory_write" };
    }

    let memoryHint = "";
    if (toolSet.has("memory_search") && turn.text.length > 3) {
      const hits = await memorySearch(
        env.KNOWLEDGE,
        turn.teamId,
        turn.channelId,
        turn.text.slice(0, 80),
        3,
      );
      if (hits.length > 0) {
        memoryHint =
          "\n\n_Knowledge:_\n" +
          hits.map((h) => `• *${h.title}*: ${h.body.slice(0, 120)}`).join("\n");
      }
    }

    if (env.AGENT_URL) {
      void fetch(env.AGENT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(env.AGENT_AUTH_HEADER
            ? { Authorization: env.AGENT_AUTH_HEADER }
            : {}),
        },
        body: JSON.stringify({
          threadId: conversationKey,
          messages: [{ role: "user", content: turn.text }],
          context: {
            systemPrompt: config.systemPrompt,
            tools,
            /** Secret *names* only — never values from channel config. */
            secretRefs: bundle.secretRefs,
            mcpEndpoints: bundle.mcpEndpoints,
            teamId: turn.teamId,
            channelId: turn.channelId,
            accessBundleId: bundle.id,
          },
        }),
      }).catch(() => undefined);
    }

    await postSlack(env, {
      channel: turn.channelId,
      thread_ts: threadTs,
      text:
        `✅ Got it (turn ${prev.hits + 1}). Bundle \`${bundle.id}\` · ${tools.length} tools.` +
        memoryHint +
        (env.AGENT_URL
          ? "\n_Agent runtime notified._"
          : "\n_Set AGENT_URL for full LLM replies._"),
    });

    return { ok: true };
  } finally {
    await store.lock.release(lockKey, lock.token);
  }
}

export async function saveHitlGate(
  env: Env,
  gate: {
    actionId: string;
    conversationKey: string;
    summary: string;
    status: "pending" | "approved" | "denied";
  },
): Promise<void> {
  const store = createDurableObjectStore(env.BOT_STATE);
  await store.kv.set(`hitl:${gate.actionId}`, gate, 86_400_000);
}

export async function resolveHitlGate(
  env: Env,
  actionId: string,
  decision: "approved" | "denied",
): Promise<{ ok: boolean; detail?: string; summary?: string }> {
  const store = createDurableObjectStore(env.BOT_STATE);
  const key = `hitl:${actionId}`;
  const gate = await store.kv.get<{
    actionId: string;
    conversationKey: string;
    summary: string;
    status: string;
  }>(key);
  if (!gate) return { ok: false, detail: "gate_not_found" };
  if (gate.status !== "pending") {
    return { ok: true, detail: `already_${gate.status}`, summary: gate.summary };
  }
  await store.kv.set(key, { ...gate, status: decision }, 86_400_000);
  return { ok: true, detail: decision, summary: gate.summary };
}

function hitlBlocks(
  actionId: string,
  summary: string,
): Array<Record<string, unknown>> {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Approval needed*\n${summary}` },
    },
    {
      type: "actions",
      block_id: `hitl_${actionId}`,
      elements: [
        {
          type: "button",
          action_id: `${actionId}:approve`,
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          value: "approve",
        },
        {
          type: "button",
          action_id: `${actionId}:deny`,
          text: { type: "plain_text", text: "Deny" },
          style: "danger",
          value: "deny",
        },
      ],
    },
  ];
}

async function postSlack(
  env: Env,
  body: {
    channel: string;
    thread_ts?: string;
    text: string;
    blocks?: Array<Record<string, unknown>>;
  },
): Promise<void> {
  if (!env.SLACK_BOT_TOKEN) return;
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
