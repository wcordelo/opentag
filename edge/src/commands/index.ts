/**
 * Slash commands for the CF bot Worker.
 */
import { defineBotCommand } from "@copilotkit/channels";
import {
  DEFAULT_BUNDLE,
  DEFAULT_SYSTEM_PROMPT,
  normalizeChannelRuntimeDefaults,
  resolveAllowedTools,
  type WorkspaceChannelConfig,
} from "../config/access-bundle.js";
import { ALL_EDGE_TOOL_NAMES } from "../tools/index.js";
import { createBotStoreAdapter } from "../create-bot-store.js";
import { loadTurnAccess } from "../config/workspace-config-do.js";
import {
  cancelTask,
  startTask,
} from "../tasks/runtime.js";
import {
  copyRequestContext,
  requireRequestContext,
} from "../request-context.js";
import { trivialAck } from "../trivial-ack.js";
import {
  bindInboundToThread,
  getInboundMessage,
} from "../slack/inbound-target.js";
import type { Env } from "../env.js";
import type { CloudflareSlackAdapter } from "../slack/cloudflare-slack-adapter.js";
import { slackObligationThreadKey } from "../slack/obligation-thread-key.js";
import { runSlackTurnLifecycle } from "../slack/turn-lifecycle.js";
import { resolveThreadOverrides } from "../store/thread-overrides.js";
import {
  adoptSlackShortcut,
  postFinalShortcut,
  runShortcutEffect,
  shortcutStillPending,
} from "../slack/shortcut-lifecycle.js";

let boundEnv: Env | null = null;
let boundAdapter: CloudflareSlackAdapter | null = null;

export function bindCommandEnv(env: Env, adapter?: CloudflareSlackAdapter): void {
  boundEnv = env;
  if (adapter) boundAdapter = adapter;
}

function requireEnv(): Env {
  if (!boundEnv) throw new Error("command env not bound");
  return boundEnv;
}

function requireAdapter(): CloudflareSlackAdapter {
  if (!boundAdapter) throw new Error("command adapter not bound");
  return boundAdapter;
}

function conversationKeyOf(thread: { conversationKey?: string }): string {
  return thread.conversationKey ?? "";
}

function channelFromKey(conversationKey: string): string {
  return conversationKey.split("::")[0] ?? "";
}

function threadTsFromKey(conversationKey: string): string | undefined {
  const scope = conversationKey.split("::")[1];
  if (!scope || scope === "dm" || scope.startsWith("slash::")) return undefined;
  return scope;
}

export function parseRuntimeCommand(
  text: string,
):
  | { kind: "show" }
  | { kind: "clear" }
  | { kind: "set"; value: unknown }
  | undefined {
  const trimmed = text.trim();
  const match = /^runtime\s+(show|clear|set)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return undefined;
  const kind = match[1]!.toLowerCase();
  const rest = (match[2] ?? "").trim();
  if (kind === "show" && !rest) return { kind: "show" };
  if (kind === "clear" && !rest) return { kind: "clear" };
  if (kind !== "set") throw new Error(`Usage: /config runtime ${kind}`);
  const tokens = rest.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  let harnessType: string | undefined;
  let model: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const [flag, inline] = token.split("=", 2);
    const value = (inline ?? tokens[++index])?.replace(/^"|"$/g, "");
    if (!flag || !value || !["--harness", "--model"].includes(flag)) {
      throw new Error(
        "Usage: /config runtime set --harness claude-code [--model <id-or-alias>]",
      );
    }
    if (flag === "--harness") harnessType = value;
    if (flag === "--model") model = value;
  }
  if (!harnessType) {
    throw new Error(
      "Usage: /config runtime set --harness claude-code [--model <id-or-alias>]",
    );
  }
  return {
    kind: "set",
    value: { harnessType, ...(model ? { model } : {}) },
  };
}

export const edgeCommands = [
  defineBotCommand({
    name: "config",
    description: "Set the channel system prompt (preserves bundle + policies).",
    async handler({ thread, text, user }) {
      const env = requireEnv();
      if (!user) throw new Error("Slack command requester is missing");
      copyRequestContext(user, thread);
      const adopted = await adoptSlackShortcut(env, requireAdapter(), thread);
      try {
        const key = conversationKeyOf(thread as { conversationKey?: string });
        const channelId = channelFromKey(key);
        const teamId = requireRequestContext(thread).teamId;
        if (requireRequestContext(thread).actor.kind !== "slack_user") {
          await postFinalShortcut(thread, "⛔ Automation actors cannot change channel configuration.");
          return;
        }
        const { config: existing } = await loadTurnAccess(
          env.WORKSPACE_CONFIG,
          teamId,
          channelId,
        );
        if (!(await shortcutStillPending(adopted))) return;
        const runtimeCommand = parseRuntimeCommand(text ?? "");
        if (runtimeCommand?.kind === "show") {
          const current = existing.runtimeDefaults;
          await postFinalShortcut(
            thread,
            current
              ? `Channel runtime default: harness \`${current.harnessType ?? "deployment"}\`, model \`${current.model ?? "harness default"}\`. Existing sticky thread choices take precedence.`
              : "Channel runtime default is not set; deployment defaults apply. Existing sticky thread choices take precedence.",
          );
          return;
        }
        const runtimeDefaults =
          runtimeCommand?.kind === "clear"
            ? undefined
            : runtimeCommand?.kind === "set"
              ? normalizeChannelRuntimeDefaults(runtimeCommand.value)
              : existing.runtimeDefaults;
        const next: WorkspaceChannelConfig = {
          teamId,
          channelId,
          systemPrompt: runtimeCommand
            ? existing.systemPrompt
            : text?.trim() || DEFAULT_SYSTEM_PROMPT,
          policies: existing.policies ?? {
            allowMemoryWrite: true,
            allowTasks: true,
          },
          accessBundleId: existing.accessBundleId || DEFAULT_BUNDLE.id,
          ...(runtimeDefaults ? { runtimeDefaults } : {}),
          updatedAt: new Date().toISOString(),
        };
        const effect = await runShortcutEffect(adopted, "command_config", async () => {
          const stub = env.WORKSPACE_CONFIG.get(
            env.WORKSPACE_CONFIG.idFromName(teamId),
          );
          const response = await stub.fetch("https://do/putConfig", {
            method: "POST",
            body: JSON.stringify(next),
          });
          return { ok: response.ok, status: response.status };
        });
        if (effect.status === "suppressed") return;
        if (!effect.value.ok) {
          await postFinalShortcut(
            thread,
            `⚠️ Config update failed: HTTP ${effect.value.status}`,
          );
          return;
        }
        await postFinalShortcut(
          thread,
          runtimeCommand?.kind === "clear"
            ? "Channel runtime default cleared. Deployment defaults now apply unless a sticky thread choice exists."
            : runtimeCommand?.kind === "set"
              ? `Channel runtime default set: harness \`${runtimeDefaults?.harnessType}\`, model \`${runtimeDefaults?.model ?? "harness default"}\`. Existing sticky thread choices take precedence.`
              : `Channel prompt updated (${next.systemPrompt.length} chars). Bundle: \`${next.accessBundleId}\` (unchanged).`,
        );
      } catch (err) {
        if (err instanceof Error && err.message === "active_turn_render_suppressed") return;
        const msg = err instanceof Error ? err.message : String(err);
        if (await shortcutStillPending(adopted)) {
          await postFinalShortcut(thread, `⚠️ Config update failed: ${msg.slice(0, 200)}`);
        }
      }
    },
  }),

  defineBotCommand({
    name: "research",
    description: "Run deep research on a topic.",
    async handler({ thread, text, user }) {
      const env = requireEnv();
      if (!user) throw new Error("Slack command requester is missing");
      copyRequestContext(user, thread);
      const adopted = await adoptSlackShortcut(env, requireAdapter(), thread);
      try {
        if (!text?.trim()) {
          await postFinalShortcut(thread, "Usage: `/research <topic>`");
          return;
        }
        const key = conversationKeyOf(thread as { conversationKey?: string });
        const channelId = channelFromKey(key);
        const threadTs = threadTsFromKey(key);
        const teamId = requireRequestContext(thread).teamId;
        const { config, bundle } = await loadTurnAccess(
          env.WORKSPACE_CONFIG,
          teamId,
          channelId,
        );
        if (!(await shortcutStillPending(adopted))) return;
        const allowed = new Set(
          resolveAllowedTools([...ALL_EDGE_TOOL_NAMES], bundle),
        );
        if (config.policies.allowTasks === false) {
          allowed.delete("start_task");
          allowed.delete("research_progress");
        }
        if (!allowed.has("start_task")) {
          await postFinalShortcut(
            thread,
            "⛔ Research / `start_task` is not allowed by this channel's access bundle or policies.",
          );
          return;
        }
        const stateStore = createBotStoreAdapter(env.BOT_STATE);
        const { cleanedText, effectiveModel } = await resolveThreadOverrides(
          stateStore,
          key,
          text,
          config.runtimeDefaults,
        );
        if (!(await shortcutStillPending(adopted))) return;
        const threadKey = slackObligationThreadKey(channelId, threadTs);
        const effect = await runShortcutEffect(adopted, "command_research", () =>
          startTask(env, {
            type: "research",
            teamId,
            threadKey,
            channelId,
            threadTs,
            model: effectiveModel,
            payload: { objective: cleanedText.trim() },
          }), {
            resource: (started) => started.status === "error" ? undefined : {
              kind: "research_task",
              teamId,
              taskId: started.taskId,
              threadKey,
            },
            cancelIfStopped: (resource) => cancelTask(env, {
              teamId: resource.teamId,
              taskId: resource.taskId,
              threadKey: resource.threadKey,
            }).then(() => undefined),
          },
        );
        if (effect.status === "suppressed") return;
        const result = effect.value;
        if (result.status === "error") {
          await postFinalShortcut(
            thread,
            `⚠️ Research failed: ${result.detail ?? "unknown"}\n` +
              `Hint: run \`npm run dev:research\` locally (or deploy opentag-orchestrator) and ensure INTERNAL_SECRET matches.`,
          );
          return;
        }
        await postFinalShortcut(
          thread,
          `🔍 Research accepted: \`${result.taskId}\` — I'll post the summary here when it's ready.`,
        );
      } catch (err) {
        if (err instanceof Error && err.message === "active_turn_render_suppressed") return;
        const msg = err instanceof Error ? err.message : String(err);
        if (await shortcutStillPending(adopted)) {
          await postFinalShortcut(thread, `⚠️ Research failed: ${msg.slice(0, 200)}`);
        }
      }
    },
  }),

  defineBotCommand({
    name: "agent",
    description: "Talk to the agent without an @-mention.",
    async handler({ thread, text, user }) {
      const env = requireEnv();
      if (!user) throw new Error("Slack command requester is missing");
      copyRequestContext(user, thread);
      const adopted = await adoptSlackShortcut(env, requireAdapter(), thread);
      try {
        if (!text?.trim()) {
          await postFinalShortcut(thread, "Usage: `/agent <message>`");
          return;
        }
        const key = conversationKeyOf(thread as { conversationKey?: string });
        bindInboundToThread(
          thread,
          requireRequestContext(thread).inbound ?? getInboundMessage(key),
        );
        const trivial = trivialAck(text);
        if (trivial) {
          // Slash commands have no inbound channel message to react on —
          // fall back to a short post.
          await postFinalShortcut(thread,
            trivial.mode === "react"
              ? trivial.emoji === "heart"
                ? "You're welcome."
                : "👍"
              : trivial.text,
          );
          return;
        }
        await runSlackTurnLifecycle(
          env,
          requireAdapter(),
          thread as Parameters<typeof runSlackTurnLifecycle>[2],
          text.trim(),
          user,
        );
      } catch (err) {
        if (
          err instanceof Error && err.message === "active_turn_render_suppressed"
        ) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (await shortcutStillPending(adopted)) {
          await postFinalShortcut(thread, `⚠️ Something went wrong: ${msg.slice(0, 200)}`);
        }
      }
    },
  }),
];
