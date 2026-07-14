export const ACTIVE_TURN_TTL_MS = 2 * 60 * 60_000;
/**
 * A claimed Stop owns a durable continuation independently of the ordinary
 * active-turn lease. Each continuation attempt refreshes this bounded lease;
 * abandoned state is still eventually reclaimed.
 */
export const STOP_CONTINUATION_TTL_MS = 24 * 60 * 60_000;

export type ActiveTurnRecord = {
  channelId: string;
  threadKey: string;
  conversationKey: string;
  executionId: string;
  threadTs?: string;
  choiceId?: string;
  registeredAt: number;
};

/** Exact downstream resource created by a fenced non-Slack effect. */
export type ActiveTurnEffectResource = {
  kind: "research_task";
  teamId: string;
  taskId: string;
  threadKey: string;
};

export type ActiveTurnDeliveryStatus =
  | "pending"
  | "cancelled"
  | "cancel_controlled"
  | "cancel_ack_in_flight"
  | "cancel_confirmed"
  | "delivered";

export type ActiveTurnSnapshot = {
  record: ActiveTurnRecord;
  status: ActiveTurnDeliveryStatus;
  renderToken?: string;
  effectToken?: string;
  effectName?: string;
  effectResource?: ActiveTurnEffectResource;
  stopEventId?: string;
  updatedAt: number;
};

export type ActiveTurnCancellationResult =
  | "claimed"
  | "retry"
  | "ack_retry"
  | "in_flight"
  | "effect_in_flight"
  | "committed"
  | "missing";

export type ActiveTurnRenderClaim =
  | { status: "claimed"; token: string }
  | { status: "cancelled" | "committed" | "in_flight" | "missing" };

/** Transactional ownership for a non-Slack tool mutation. */
export type ActiveTurnEffectClaim = ActiveTurnRenderClaim;
