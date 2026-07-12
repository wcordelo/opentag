/**
 * Request-scoped team id for commands/tools (set by Worker before sink calls).
 */
let currentTeamId = "default";

export function setCurrentTeamId(teamId: string): void {
  currentTeamId = teamId || "default";
}

export function getCurrentTeamId(): string {
  return currentTeamId;
}
