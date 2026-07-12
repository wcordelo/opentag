/**
 * Slack Events API handler — `POST /slack/events`.
 *
 * Scope per DECISIONS.md §3: only research-intent events are routed to the
 * Orchestrator DO. Everything else stays a no-op 200 ack (Railway's job).
 *
 * Intent classification prefers the WASM_DISPATCH service binding (Track D);
 * falls back to local isResearchIntent if the binding is unavailable.
 */
import type { Context } from "hono";
import type { AppEnv } from "./env";
import { buildThreadKey } from "./slack-intent";
import { DispatchClient } from "./dispatch-client";
import { fireAndForget } from "./fire-and-forget";

const RESEARCH_EVENT_TYPES = new Set(["app_mention", "message.im", "message.mpim"]);

interface SlackUrlVerificationBody {
  type: "url_verification";
  challenge: string;
}

interface SlackEventCallbackEvent {
  type: string;
  text?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
}

interface SlackEventCallbackBody {
  type: "event_callback";
  team_id: string;
  event_id?: string;
  event: SlackEventCallbackEvent;
}

type SlackEventBody =
  | SlackUrlVerificationBody
  | SlackEventCallbackBody
  | { type: string; [key: string]: unknown };

export async function handleSlackEvents(
  c: Context<AppEnv>,
): Promise<Response> {
  const body = c.get("slackPayload") as SlackEventBody | undefined;

  if (!body) {
    return c.json({ ok: true }, 200);
  }

  if (body.type === "url_verification") {
    const verification = body as SlackUrlVerificationBody;
    return c.json({ challenge: verification.challenge }, 200);
  }

  if (body.type === "event_callback") {
    const callback = body as SlackEventCallbackBody;
    const event = callback.event;

    if (event && RESEARCH_EVENT_TYPES.has(event.type)) {
      const dispatch = new DispatchClient(c.env);
      const classification = await dispatch.classify(
        event.text ?? "",
        event.user,
        event.channel,
      );

      if (classification.intent === "research") {
        const threadKey = buildThreadKey(
          "slack",
          event.channel,
          event.thread_ts ?? event.ts,
        );

        // Per DECISIONS.md §1: OrchestratorDO is per Slack *workspace*
        // (top-level `team_id` on the event payload), not per thread.
        const id = c.env.ORCHESTRATOR.idFromName(callback.team_id);
        const stub = c.env.ORCHESTRATOR.get(id);

        // Fire-and-forget: Slack requires a 200 ack within 3s.
        fireAndForget(
          c,
          stub.fetch(
            new Request("https://do/handleMention", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                threadKey,
                objective: classification.extractedObjective,
                eventId: callback.event_id,
                eventTs: event.ts,
                channelId: event.channel,
              }),
            }),
          ),
        );
      }
    }

    return c.json({ ok: true }, 200);
  }

  return c.json({ ok: true }, 200);
}
