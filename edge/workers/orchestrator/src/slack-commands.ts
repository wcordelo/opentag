/**
 * Slack Slash Commands handler — `POST /slack/commands`.
 *
 * Scope per DECISIONS.md §3: only `/research` is handled here; every other
 * slash command stays on the existing Railway/CopilotKit bot.
 */
import type { Context } from "hono";
import type { AppEnv } from "./env";
import { buildThreadKey, extractResearchObjective } from "./slack-intent";
import { fireAndForget } from "./fire-and-forget";

export async function handleSlackCommands(
  c: Context<AppEnv>,
): Promise<Response> {
  const rawBody = c.get("rawBody") ?? "";
  const params = new URLSearchParams(rawBody);

  const command = params.get("command") ?? "";
  const text = (params.get("text") ?? "").trim();
  const channelId = params.get("channel_id") ?? "";
  const teamId = params.get("team_id") ?? "";

  if (command !== "/research") {
    return c.json(
      { text: "This command isn't available on this deployment yet." },
      200,
    );
  }

  if (!text) {
    return c.json({ text: "Usage: /research <topic>" }, 200);
  }

  const threadKey = buildThreadKey("slack", channelId, channelId);

  const id = c.env.ORCHESTRATOR.idFromName(teamId);
  const stub = c.env.ORCHESTRATOR.get(id);

  fireAndForget(
    c,
    stub.fetch(
      new Request("https://do/handleMention", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadKey,
          objective: extractResearchObjective(text),
          channelId,
        }),
      }),
    ),
  );

  return c.json({ response_type: "in_channel", text: "🔍 Research started…" }, 200);
}
