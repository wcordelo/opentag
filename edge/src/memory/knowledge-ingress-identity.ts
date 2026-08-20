export function knowledgeEventIngressId(teamId: string, eventId: string): string {
  return `knowledge-event:${encodeURIComponent(teamId)}:${encodeURIComponent(eventId)}`;
}

export function knowledgeObservationIngressId(
  teamId: string,
  operation: "posted" | "updated",
  channelId: string,
  ts: string,
  observationId?: string,
): string {
  const parts = [
    "knowledge-observation",
    encodeURIComponent(teamId),
    operation,
    encodeURIComponent(channelId),
    encodeURIComponent(ts),
  ];
  if (observationId) parts.push(encodeURIComponent(observationId));
  return parts.join(":");
}

export function reactionCleanupIngressId(
  teamId: string,
  channelId: string,
  ts: string,
  name: string,
): string {
  return [
    "reaction-cleanup",
    encodeURIComponent(teamId),
    encodeURIComponent(channelId),
    encodeURIComponent(ts),
    encodeURIComponent(name),
  ].join(":");
}
