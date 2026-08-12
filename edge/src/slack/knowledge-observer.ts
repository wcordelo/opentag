import type { Env } from "../env.js";
import type { DeferredIngressJob } from "../deferred-ingress-do.js";
import {
  knowledgeObservationIngressId,
} from "../memory/knowledge-ingress-identity.js";
import { stableSlackClientMessageId } from "./client-message-id.js";
import {
  scheduleKnowledgeFromSlackMessage,
  type SlackKnowledgeMessageObservation,
} from "../memory/knowledge-jobs.js";
import type {
  SlackMessageObservation,
  SlackMessageObserver,
} from "./web-api.js";

type KnowledgeObserverEnv = Pick<
  Env,
  "WORKSPACE_CONFIG" | "KNOWLEDGE" | "DEFERRED_INGRESS"
>;

export type SlackKnowledgeMessageObserver = (
  teamId: string | undefined,
  observation: SlackMessageObservation,
) => Promise<void> | void;

function observationRevision(observation: SlackMessageObservation): string {
  return stableSlackClientMessageId(JSON.stringify([
    "knowledge-observation-v2",
    observation.operation,
    observation.channel,
    observation.ts,
    observation.threadTs ?? "",
    observation.text,
    observation.blocks ?? null,
    observation.attachments ?? null,
  ]));
}

export function createSlackKnowledgeObserver(
  env: Partial<KnowledgeObserverEnv>,
): SlackKnowledgeMessageObserver | undefined {
  const hasDirectSchedule = Boolean(
    env.WORKSPACE_CONFIG &&
    typeof env.WORKSPACE_CONFIG.idFromName === "function" &&
    typeof env.WORKSPACE_CONFIG.get === "function" &&
    env.KNOWLEDGE &&
    typeof env.KNOWLEDGE.idFromName === "function" &&
    typeof env.KNOWLEDGE.get === "function",
  );
  const hasDurableIngress = Boolean(
    env.DEFERRED_INGRESS &&
    typeof env.DEFERRED_INGRESS.idFromName === "function" &&
    typeof env.DEFERRED_INGRESS.get === "function",
  );
  if (!hasDirectSchedule && !hasDurableIngress) return undefined;
  const scheduleEnv = env as KnowledgeObserverEnv;
  return async (teamId, observation) => {
    if (!teamId?.trim() || teamId === "unknown") {
      console.error("[slack] outbound knowledge observation missing team id", {
        channel: observation.channel,
        ts: observation.ts,
      });
      throw new Error("knowledge_observation_team_required");
    }
    if (hasDurableIngress) {
      const observationId = observation.observationId ??
        (observation.operation === "updated"
          ? observationRevision(observation)
          : undefined);
      const id = knowledgeObservationIngressId(
        teamId,
        observation.operation,
        observation.channel,
        observation.ts,
        observationId,
      );
      const durableObservation = observationId
        ? { ...observation, observationId }
        : observation;
      const stub = scheduleEnv.DEFERRED_INGRESS!.get(
        scheduleEnv.DEFERRED_INGRESS!.idFromName(id),
      ) as unknown as {
        prepare(job: DeferredIngressJob): Promise<{
          accepted: boolean;
          status: "pending" | "running" | "completed" | "exhausted";
        }>;
      };
      const ownership = await stub.prepare({
        id,
        kind: "knowledge_observation",
        teamId,
        payload: { teamId, observation: durableObservation },
      });
      if (ownership.status === "exhausted") {
        throw new Error("knowledge_observation_ingress_exhausted");
      }
      console.log(JSON.stringify({
        metric: "slack_outbound_knowledge_durably_owned",
        teamId,
        channelId: observation.channel,
        threadTs: observation.threadTs ?? observation.ts,
        operation: observation.operation,
      }));
      return;
    }
    if (!hasDirectSchedule) throw new Error("knowledge_observer_unavailable");
    const input: SlackKnowledgeMessageObservation = {
      teamId,
      channelId: observation.channel,
      ts: observation.ts,
      ...(observation.threadTs ? { threadTs: observation.threadTs } : {}),
      operation: observation.operation,
    };
    const result = await scheduleKnowledgeFromSlackMessage(scheduleEnv, input);
    console.log(JSON.stringify({
      metric: "slack_outbound_knowledge_scheduled",
      teamId,
      channelId: observation.channel,
      threadTs: observation.threadTs ?? observation.ts,
      operation: observation.operation,
      scheduled: result.scheduled,
    }));
  };
}

export function bindSlackKnowledgeObserver(
  observer: SlackKnowledgeMessageObserver | undefined,
  teamId: string | undefined,
): SlackMessageObserver | undefined {
  if (!observer || !teamId) return undefined;
  return (observation) => observer(teamId, observation);
}
